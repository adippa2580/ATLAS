import {
  BadRequestException,
  Body,
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { IsOptional, IsString } from 'class-validator';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { PrismaService } from '../common/prisma/prisma.service';
import { TenantContext } from '../common/tenancy/tenant-context';
import {
  CatalogIngestModule,
  CatalogIngestService,
} from '../modules/marketing/entities/catalog-ingest.module';
import { TasteModule } from '../modules/guest/taste/taste.module';
import { AffinityRecomputeService } from '../modules/guest/taste/affinity-recompute.service';

/** The A-List flagship tenant — where the operator's taste graph lives. */
const FLAGSHIP_TENANT_ID = '00000000-0000-0000-0000-00000000a115';
const COOKIE_NAME = 'atlas_admin';
const SESSION_TTL_SECONDS = 8 * 60 * 60; // 8h

class LoginDto {
  @IsString() username!: string;
  @IsString() password!: string;
}
class LoadDto {
  @IsOptional() @IsString() city?: string;
  // Tenant to recompute after ingest; omitted / 'all' → every tenant.
  @IsOptional() @IsString() tenant?: string;
}

/** Normalize a tenant query param: '', 'all', undefined → undefined (aggregate). */
function tenantFilter(tenant?: string): string | undefined {
  const t = tenant?.trim();
  return !t || t === 'all' ? undefined : t;
}

/** Read the named cookie out of a raw Cookie header (no cookie-parser dep). */
function readCookie(header: string | undefined, name: string): string {
  if (!header) return '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) {
      return decodeURIComponent(part.slice(i + 1).trim());
    }
  }
  return '';
}

const round = (n: number) => Math.round(n * 1000) / 1000;

@Injectable()
export class AdminService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly catalog: CatalogIngestService,
    private readonly recompute: AffinityRecomputeService,
  ) {}

  private get sessionSecret(): string {
    return this.config.get<string>('admin.sessionSecret') ?? '';
  }

  private get users(): Record<string, string> {
    return this.config.get<Record<string, string>>('admin.users') ?? {};
  }

  /** Admin login only works when a session secret AND ≥1 user are configured. */
  get configured(): boolean {
    return !!this.sessionSecret && Object.keys(this.users).length > 0;
  }

  /** Constant-time credential check (hash both sides so length can't leak). */
  verifyCredentials(username: string, password: string): boolean {
    const stored = this.users[username];
    if (!stored) return false;
    const a = createHash('sha256').update(password).digest();
    const b = createHash('sha256').update(stored).digest();
    return timingSafeEqual(a, b);
  }

  /** HMAC-signed session token: base64url(payload).base64url(sig). */
  issueSession(sub: string, now = Math.floor(Date.now() / 1000)): string {
    const payload = Buffer.from(
      JSON.stringify({ sub, exp: now + SESSION_TTL_SECONDS }),
    ).toString('base64url');
    const sig = createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    return `${payload}.${sig}`;
  }

  /** Verify a session token → username, or null (bad sig / expired / malformed). */
  verifySession(
    token: string,
    now = Math.floor(Date.now() / 1000),
  ): string | null {
    if (!token || !this.sessionSecret) return null;
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return null;
    const expected = createHmac('sha256', this.sessionSecret)
      .update(payload)
      .digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
      const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
      if (
        typeof data.sub !== 'string' ||
        typeof data.exp !== 'number' ||
        data.exp < now
      ) {
        return null;
      }
      return data.sub;
    } catch {
      return null;
    }
  }

  /** Tenants the admin can scope the graph to (plus an implicit "all"). */
  async tenants() {
    const rows = await this.prisma.tenant.findMany({
      select: { id: true, name: true, kind: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows;
  }

  /** Human label for the selected scope. */
  private async scopeLabel(tenantId?: string): Promise<string> {
    if (!tenantId) return 'All tenants';
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    return t?.name ?? tenantId;
  }

  /**
   * A snapshot of the taste graph + global catalog. Scoped to one tenant, or
   * aggregated across ALL tenants when `tenantId` is omitted.
   */
  async graph(tenantId?: string) {
    // Tenant-scoped where fragment: a specific tenant, or {} for all tenants.
    const tw = tenantId ? { tenantId } : {};
    const [
      entityKinds,
      guests,
      consents,
      crews,
      evidenceTotal,
      affinityTotal,
      affinities,
      recentEvidence,
      affinityByType,
      label,
    ] = await Promise.all([
      this.prisma.entity.groupBy({ by: ['kind'], _count: { _all: true } }),
      this.prisma.guest.count({ where: tw }),
      this.prisma.consentGrant.count({ where: { ...tw, revokedAt: null } }),
      this.prisma.crew.count({ where: tw }),
      this.prisma.affinityEvidence.count({ where: tw }),
      this.prisma.guestAffinity.count({ where: tw }),
      this.prisma.guestAffinity.findMany({
        where: { ...tw, muted: false },
        orderBy: { score: 'desc' },
        take: 400,
        select: { subjectType: true, subjectRef: true, score: true },
      }),
      this.prisma.affinityEvidence.findMany({
        where: tw,
        orderBy: { observedAt: 'desc' },
        take: 12,
        select: {
          subjectType: true,
          subjectRef: true,
          signal: true,
          provenance: true,
          weight: true,
          observedAt: true,
        },
      }),
      this.prisma.guestAffinity.groupBy({
        by: ['subjectType'],
        where: { ...tw, muted: false },
        _count: { _all: true },
      }),
      this.scopeLabel(tenantId),
    ]);

    // Aggregate the graph by subject (sum score, count distinct-ish guests).
    const bySubject = new Map<
      string,
      { subjectType: string; subjectRef: string; sum: number; guests: number }
    >();
    for (const a of affinities) {
      const k = `${a.subjectType}:${a.subjectRef}`;
      const cur = bySubject.get(k) ?? {
        subjectType: a.subjectType,
        subjectRef: a.subjectRef,
        sum: 0,
        guests: 0,
      };
      cur.sum += a.score;
      cur.guests += 1;
      bySubject.set(k, cur);
    }
    const ranked = [...bySubject.values()]
      .sort((x, y) => y.sum - x.sum)
      .map((s) => ({
        subjectType: s.subjectType,
        subjectRef: s.subjectRef,
        score: round(s.sum),
        guests: s.guests,
      }));

    return {
      tenant: label,
      entities: Object.fromEntries(
        entityKinds.map((e) => [e.kind, e._count._all]),
      ),
      counts: {
        guests,
        consents,
        crews,
        evidence: evidenceTotal,
        affinities: affinityTotal,
      },
      // Distinct-ish affinity rows per subject type (where genres actually live —
      // they aren't catalog entities, so the Genres tile drills into affinities).
      subjects: Object.fromEntries(
        affinityByType.map((a) => [a.subjectType, a._count._all]),
      ),
      topArtists: ranked.filter((s) => s.subjectType === 'artist').slice(0, 10),
      topGenres: ranked.filter((s) => s.subjectType === 'genre').slice(0, 10),
      recentEvidence,
    };
  }

  /**
   * Load/refresh: (1) ingest the class-3 catalog for a city, then (2) fully
   * rebuild derived affinities by folding each distinct evidence key through the
   * recompute service — for one tenant, or every tenant when unscoped. Returns
   * the refreshed graph. Recompute is idempotent + consent-respecting.
   */
  async load(city = 'Miami', tenantId?: string) {
    const ctx = { tenantId: FLAGSHIP_TENANT_ID, scopes: [] } as TenantContext;
    const ingested = await this.catalog.ingest(ctx, { city });

    // Distinct (tenant, guest, subject) evidence keys to rebuild.
    const keys = await this.prisma.affinityEvidence.findMany({
      where: tenantId ? { tenantId } : {},
      distinct: ['tenantId', 'guestId', 'subjectType', 'subjectRef'],
      select: {
        tenantId: true,
        guestId: true,
        subjectType: true,
        subjectRef: true,
      },
    });
    // Bounded concurrency so a large graph doesn't open hundreds of tx at once.
    let recomputed = 0;
    for (let i = 0; i < keys.length; i += 8) {
      const batch = keys.slice(i, i + 8);
      await Promise.all(
        batch.map((k) =>
          this.recompute.recomputeSubject(
            k.tenantId,
            k.guestId,
            k.subjectType,
            k.subjectRef,
          ),
        ),
      );
      recomputed += batch.length;
    }

    return { ingested, recomputed, graph: await this.graph(tenantId) };
  }

  /**
   * The set of collectible database elements the console can browse, each with
   * its display columns. Drives both the drill endpoint and the UI's tiles.
   */
  static readonly COLLECTIONS: Record<
    string,
    { label: string; columns: { key: string; label: string }[] }
  > = {
    guests: {
      label: 'Guests',
      columns: [
        { key: 'displayName', label: 'guest' },
        { key: 'email', label: 'email' },
        { key: 'primaryPhone', label: 'phone' },
        { key: 'affinities', label: 'affinities' },
        { key: 'consents', label: 'consents' },
        { key: 'evidence', label: 'evidence' },
        { key: 'provisional', label: 'provisional' },
        { key: 'createdAt', label: 'first seen' },
      ],
    },
    consents: {
      label: 'Consents',
      columns: [
        { key: 'guest', label: 'guest' },
        { key: 'scope', label: 'scope' },
        { key: 'basis', label: 'basis' },
        { key: 'connector', label: 'connector' },
        { key: 'grantedAt', label: 'granted' },
        { key: 'status', label: 'status' },
      ],
    },
    evidence: {
      label: 'Evidence',
      columns: [
        { key: 'guest', label: 'guest' },
        { key: 'subject', label: 'subject' },
        { key: 'signal', label: 'signal' },
        { key: 'weight', label: 'weight' },
        { key: 'provenance', label: 'provenance' },
        { key: 'observedAt', label: 'observed' },
      ],
    },
    affinities: {
      label: 'Affinities',
      columns: [
        { key: 'guest', label: 'guest' },
        { key: 'subject', label: 'subject' },
        { key: 'score', label: 'score' },
        { key: 'muted', label: 'muted' },
      ],
    },
    crews: {
      label: 'Crews',
      columns: [
        { key: 'name', label: 'crew' },
        { key: 'members', label: 'members' },
        { key: 'affinities', label: 'blend rows' },
        { key: 'createdAt', label: 'created' },
      ],
    },
    identity: {
      label: 'Identity links',
      columns: [
        { key: 'guest', label: 'guest' },
        { key: 'kind', label: 'kind' },
        { key: 'valueHash', label: 'value (hashed)' },
        { key: 'verified', label: 'verified' },
        { key: 'source', label: 'source' },
      ],
    },
    entities: {
      label: 'Catalog entities',
      columns: [
        { key: 'kind', label: 'kind' },
        { key: 'name', label: 'name' },
        { key: 'refs', label: 'external refs' },
        { key: 'createdAt', label: 'ingested' },
      ],
    },
  };

  private static readonly PAGE_SIZE = 25;

  /** Valid taste-graph subject types (guards the affinities/evidence type filter). */
  private static readonly SUBJECT_TYPES = new Set([
    'artist',
    'genre',
    'venue',
    'event',
    'crew',
    'table',
    'product',
  ]);

  private guestName(g: {
    displayName?: string | null;
    email?: string | null;
    id: string;
  }): string {
    return g.displayName || g.email || g.id.slice(0, 8);
  }

  /**
   * Browse one collected element, tenant-scoped (or all tenants), paginated and
   * text-filtered. Read-only. Returns typed rows the UI renders generically.
   */
  async collection(
    name: string,
    opts: {
      tenantId?: string;
      q?: string;
      page?: number;
      kind?: string;
      type?: string;
    } = {},
  ) {
    const spec = AdminService.COLLECTIONS[name];
    if (!spec) throw new BadRequestException(`unknown collection: ${name}`);
    const tw = opts.tenantId ? { tenantId: opts.tenantId } : {};
    const take = AdminService.PAGE_SIZE;
    const page = Math.max(1, Math.floor(opts.page ?? 1));
    const skip = (page - 1) * take;
    const q = (opts.q ?? '').trim();
    const like = q ? { contains: q, mode: 'insensitive' as const } : undefined;

    let total = 0;
    let rows: Record<string, unknown>[] = [];

    if (name === 'guests') {
      const where = {
        ...tw,
        ...(like
          ? {
              OR: [
                { displayName: like },
                { email: like },
                { primaryPhone: like },
              ],
            }
          : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.guest.count({ where }),
        this.prisma.guest.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            id: true,
            displayName: true,
            email: true,
            primaryPhone: true,
            provisional: true,
            createdAt: true,
            _count: {
              select: { affinities: true, consents: true, evidence: true },
            },
          },
        }),
      ]);
      total = count;
      rows = list.map((g) => ({
        id: g.id,
        displayName: this.guestName(g),
        email: g.email ?? '—',
        primaryPhone: g.primaryPhone ?? '—',
        affinities: g._count.affinities,
        consents: g._count.consents,
        evidence: g._count.evidence,
        provisional: g.provisional,
        createdAt: g.createdAt,
      }));
    } else if (name === 'consents') {
      const where = {
        ...tw,
        ...(like ? { OR: [{ scope: like }, { connector: like }] } : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.consentGrant.count({ where }),
        this.prisma.consentGrant.findMany({
          where,
          orderBy: { grantedAt: 'desc' },
          skip,
          take,
          select: {
            scope: true,
            basis: true,
            connector: true,
            grantedAt: true,
            revokedAt: true,
            guest: { select: { id: true, displayName: true, email: true } },
          },
        }),
      ]);
      total = count;
      rows = list.map((c) => ({
        guestId: c.guest.id,
        guest: this.guestName(c.guest),
        scope: c.scope,
        basis: c.basis,
        connector: c.connector ?? '—',
        grantedAt: c.grantedAt,
        status: c.revokedAt ? 'revoked' : 'active',
      }));
    } else if (name === 'evidence') {
      const type = (opts.type ?? '').trim();
      const where = {
        ...tw,
        ...(like ? { subjectRef: like } : {}),
        ...(AdminService.SUBJECT_TYPES.has(type)
          ? { subjectType: type as never }
          : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.affinityEvidence.count({ where }),
        this.prisma.affinityEvidence.findMany({
          where,
          orderBy: { observedAt: 'desc' },
          skip,
          take,
          select: {
            subjectType: true,
            subjectRef: true,
            signal: true,
            weight: true,
            provenance: true,
            observedAt: true,
            guest: { select: { id: true, displayName: true, email: true } },
          },
        }),
      ]);
      total = count;
      rows = list.map((e) => ({
        guestId: e.guest.id,
        guest: this.guestName(e.guest),
        subject: `${e.subjectType} · ${e.subjectRef}`,
        signal: e.signal,
        weight: e.weight,
        provenance: e.provenance,
        observedAt: e.observedAt,
      }));
    } else if (name === 'affinities') {
      const type = (opts.type ?? '').trim();
      const where = {
        ...tw,
        ...(like ? { subjectRef: like } : {}),
        ...(AdminService.SUBJECT_TYPES.has(type)
          ? { subjectType: type as never }
          : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.guestAffinity.count({ where }),
        this.prisma.guestAffinity.findMany({
          where,
          orderBy: { score: 'desc' },
          skip,
          take,
          select: {
            subjectType: true,
            subjectRef: true,
            score: true,
            muted: true,
            guest: { select: { id: true, displayName: true, email: true } },
          },
        }),
      ]);
      total = count;
      rows = list.map((a) => ({
        guestId: a.guest.id,
        guest: this.guestName(a.guest),
        subject: `${a.subjectType} · ${a.subjectRef}`,
        score: round(a.score),
        muted: a.muted,
      }));
    } else if (name === 'crews') {
      const where = {
        ...tw,
        ...(like ? { name: like } : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.crew.count({ where }),
        this.prisma.crew.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            id: true,
            name: true,
            createdAt: true,
            _count: { select: { members: true, affinities: true } },
          },
        }),
      ]);
      total = count;
      rows = list.map((c) => ({
        id: c.id,
        name: c.name || c.id.slice(0, 8),
        members: c._count.members,
        affinities: c._count.affinities,
        createdAt: c.createdAt,
      }));
    } else if (name === 'identity') {
      const where = {
        ...tw,
        ...(like ? { source: like } : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.identityLink.count({ where }),
        this.prisma.identityLink.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            kind: true,
            valueHash: true,
            verified: true,
            source: true,
            guest: { select: { id: true, displayName: true, email: true } },
          },
        }),
      ]);
      total = count;
      rows = list.map((l) => ({
        guestId: l.guest.id,
        guest: this.guestName(l.guest),
        kind: l.kind,
        valueHash: `${String(l.valueHash).slice(0, 10)}…`,
        verified: l.verified,
        source: l.source ?? '—',
      }));
    } else if (name === 'entities') {
      // Global catalog — not tenant-scoped. Optionally narrowed to one kind so
      // the Artists / Genres / Venues / Events tiles each drill to their slice.
      const kind = (opts.kind ?? '').trim();
      const validKind = ['artist', 'event', 'venue'].includes(kind);
      const where = {
        ...(like ? { name: like } : {}),
        ...(validKind ? { kind: kind as never } : {}),
      };
      const [count, list] = await Promise.all([
        this.prisma.entity.count({ where }),
        this.prisma.entity.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          skip,
          take,
          select: {
            kind: true,
            name: true,
            externalRefs: true,
            createdAt: true,
          },
        }),
      ]);
      total = count;
      rows = list.map((e) => ({
        kind: e.kind,
        name: e.name,
        refs: e.externalRefs
          ? Object.keys(e.externalRefs as object).join(', ') || '—'
          : '—',
        createdAt: e.createdAt,
      }));
    }

    return {
      name,
      label: spec.label,
      columns: spec.columns,
      total,
      page,
      pageSize: take,
      pages: Math.max(1, Math.ceil(total / take)),
      rows,
    };
  }

  /**
   * Guest 360: everything the taste graph holds for one guest — identity links,
   * consents, top affinities, recent evidence, crews, entitlements. Tenant-scoped
   * so an admin viewing one tenant can't reach another's guest.
   */
  async guestDetail(id: string, tenantId?: string) {
    const guest = await this.prisma.guest.findFirst({
      where: { id, ...(tenantId ? { tenantId } : {}) },
      select: {
        id: true,
        tenantId: true,
        displayName: true,
        email: true,
        primaryPhone: true,
        provisional: true,
        createdAt: true,
      },
    });
    if (!guest) throw new NotFoundException('guest not found');

    const [links, consents, affinities, evidence, crews, entitlements] =
      await Promise.all([
        this.prisma.identityLink.findMany({
          where: { guestId: id },
          select: { kind: true, verified: true, source: true },
        }),
        this.prisma.consentGrant.findMany({
          where: { guestId: id },
          orderBy: { grantedAt: 'desc' },
          select: {
            scope: true,
            basis: true,
            connector: true,
            grantedAt: true,
            revokedAt: true,
          },
        }),
        this.prisma.guestAffinity.findMany({
          where: { guestId: id, muted: false },
          orderBy: { score: 'desc' },
          take: 20,
          select: { subjectType: true, subjectRef: true, score: true },
        }),
        this.prisma.affinityEvidence.findMany({
          where: { guestId: id },
          orderBy: { observedAt: 'desc' },
          take: 20,
          select: {
            subjectType: true,
            subjectRef: true,
            signal: true,
            weight: true,
            provenance: true,
            observedAt: true,
          },
        }),
        this.prisma.crewMember.findMany({
          where: { guestId: id },
          select: {
            role: true,
            crew: { select: { id: true, name: true } },
          },
        }),
        this.prisma.entitlement.findMany({
          where: { guestId: id },
          select: { kind: true, state: true, expiresAt: true },
        }),
      ]);

    return {
      guest: { ...guest, displayName: this.guestName(guest) },
      identity: links,
      consents,
      affinities: affinities.map((a) => ({ ...a, score: round(a.score) })),
      evidence,
      crews: crews.map((m) => ({
        id: m.crew.id,
        name: m.crew.name || m.crew.id.slice(0, 8),
        role: m.role,
      })),
      entitlements,
    };
  }
}

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(private readonly svc: AdminService) {}
  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const token = readCookie(req.headers?.cookie, COOKIE_NAME);
    const user = this.svc.verifySession(token);
    if (!user) throw new UnauthorizedException('admin session required');
    (req as unknown as { adminUser: string }).adminUser = user;
    return true;
  }
}

@ApiTags('admin')
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  private get secureCookies(): boolean {
    return process.env.NODE_ENV === 'production';
  }

  @Get()
  page(@Res() res: Response): void {
    res.type('html').send(adminPage());
  }

  @Post('login')
  login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) res: Response,
  ): { ok: true; user: string } {
    if (!this.svc.configured) {
      throw new ServiceUnavailableException('Admin login is not configured');
    }
    if (!this.svc.verifyCredentials(dto.username, dto.password)) {
      throw new UnauthorizedException('Invalid credentials');
    }
    res.cookie(COOKIE_NAME, this.svc.issueSession(dto.username), {
      httpOnly: true,
      secure: this.secureCookies,
      sameSite: 'lax',
      path: '/admin',
      maxAge: SESSION_TTL_SECONDS * 1000,
    });
    return { ok: true, user: dto.username };
  }

  @Post('logout')
  logout(@Res({ passthrough: true }) res: Response): { ok: true } {
    res.clearCookie(COOKIE_NAME, { path: '/admin' });
    return { ok: true };
  }

  @Get('session')
  session(@Req() req: Request): {
    authenticated: boolean;
    user: string | null;
    configured: boolean;
  } {
    const user = this.svc.verifySession(
      readCookie(req.headers?.cookie, COOKIE_NAME),
    );
    return {
      authenticated: !!user,
      user: user ?? null,
      configured: this.svc.configured,
    };
  }

  @Get('tenants')
  @UseGuards(AdminGuard)
  tenants() {
    return this.svc.tenants();
  }

  @Get('graph')
  @UseGuards(AdminGuard)
  graph(@Query('tenant') tenant?: string) {
    return this.svc.graph(tenantFilter(tenant));
  }

  @Get('collection')
  @UseGuards(AdminGuard)
  collection(
    @Query('name') name: string,
    @Query('tenant') tenant?: string,
    @Query('q') q?: string,
    @Query('page') page?: string,
    @Query('kind') kind?: string,
    @Query('type') type?: string,
  ) {
    const p = page ? parseInt(page, 10) : 1;
    return this.svc.collection(name, {
      tenantId: tenantFilter(tenant),
      q,
      kind,
      type,
      page: Number.isFinite(p) ? p : 1,
    });
  }

  @Get('guest/:id')
  @UseGuards(AdminGuard)
  guest(@Param('id') id: string, @Query('tenant') tenant?: string) {
    return this.svc.guestDetail(id, tenantFilter(tenant));
  }

  @Post('load')
  @UseGuards(AdminGuard)
  load(@Body() dto: LoadDto) {
    return this.svc.load(dto.city, tenantFilter(dto.tenant));
  }
}

/** The self-contained admin console (Atlas v3.1 dark, red-free). */
function adminPage(): string {
  return `<!doctype html><meta charset="utf-8"><title>ATLAS · Admin</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root{--bg:#04050A;--card:#0B0E17;--input:#111524;--line:#1b2233;--ink:#F5F7FF;--mut:#B8C0D4;--faint:#6B7280;--violet:#A78BFA;--cyan:#22D3EE;--blue:#60A5FA;--amber:#FBBF24;--mint:#34D399}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font-family:"Helvetica Neue",system-ui,sans-serif;min-height:100vh}
  .wrap{max-width:1040px;margin:0 auto;padding:28px 20px}
  h1{font-size:19px;letter-spacing:.5px;margin:0 0 2px}
  .sub{color:var(--faint);font-size:12px;margin-bottom:22px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:22px;margin-bottom:16px}
  label{display:block;font-size:11px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:12px 0 6px}
  input{width:100%;padding:11px 13px;background:var(--input);border:1px solid var(--line);border-radius:9px;color:var(--ink);font-size:14px}
  button{appearance:none;cursor:pointer;border:0;border-radius:9px;font-size:13px;font-weight:600;padding:10px 18px;font-family:inherit}
  .primary{background:var(--violet);color:#0b0b14}
  .ghost{background:transparent;border:1px solid var(--line);color:var(--ink)}
  .row{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
  .err{color:var(--amber);font-size:13px;margin-top:10px;min-height:16px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:10px}
  .kpi{background:var(--input);border:1px solid var(--line);border-radius:10px;padding:12px}
  .kpi .k{font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--faint)}
  .kpi .v{font-size:22px;font-weight:600;margin-top:3px}
  h3{font-size:12px;text-transform:uppercase;letter-spacing:.6px;color:var(--mut);margin:20px 0 10px}
  .bars .b{display:flex;align-items:center;gap:10px;margin:6px 0;font-size:13px}
  .bars .b span:first-child{width:150px;color:var(--ink)}
  .tk{flex:1;height:7px;background:var(--input);border-radius:99px;overflow:hidden}
  .tk i{display:block;height:100%;background:linear-gradient(90deg,var(--violet),var(--cyan))}
  .n{width:52px;text-align:right;color:var(--mut);font-variant-numeric:tabular-nums}
  table{width:100%;border-collapse:collapse;font-size:12.5px}
  th{text-align:left;color:var(--faint);font-weight:500;text-transform:uppercase;letter-spacing:.5px;font-size:10px;padding:6px 8px;border-bottom:1px solid var(--line)}
  td{padding:6px 8px;border-bottom:1px solid #10141f;color:var(--mut)}
  .two{display:grid;grid-template-columns:1fr 1fr;gap:20px}
  @media(max-width:720px){.two{grid-template-columns:1fr}.bars .b span:first-child{width:110px}}
  .pill{font-size:10px;color:var(--faint)}
  .muted{color:var(--faint);font-size:12px}
  .kpi.clik{cursor:pointer;transition:border-color .15s,transform .05s}
  .kpi.clik:hover{border-color:var(--violet)}
  .kpi.clik:active{transform:translateY(1px)}
  .kpi .go{font-size:9px;color:var(--violet);margin-top:4px;text-transform:uppercase;letter-spacing:.5px}
  .exhead{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap}
  .exhead h2{font-size:15px;margin:0}
  .search{width:220px;padding:9px 11px;background:var(--input);border:1px solid var(--line);border-radius:9px;color:var(--ink);font-size:13px}
  tr.clik{cursor:pointer}
  tr.clik:hover td{background:var(--input);color:var(--ink)}
  .chip{display:inline-block;font-size:10px;padding:2px 7px;border-radius:99px;border:1px solid var(--line);color:var(--mut)}
  .chip.on{color:var(--mint);border-color:var(--mint)}
  .chip.off{color:var(--faint)}
  .pager{display:flex;gap:10px;align-items:center;justify-content:flex-end;margin-top:12px;font-size:12px;color:var(--mut)}
  .pager button{padding:7px 12px;background:var(--input);border:1px solid var(--line);color:var(--ink)}
  .pager button:disabled{opacity:.4;cursor:default}
  .drawer{position:fixed;inset:0;background:rgba(2,3,8,.62);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;overflow:auto;z-index:50}
  .drawer.open{display:flex}
  .drawer .panel{background:var(--card);border:1px solid var(--line);border-radius:16px;max-width:760px;width:100%;padding:24px}
  .dl{display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px;margin:6px 0 4px}
  .dl dt{color:var(--faint)}
  .dl dd{margin:0;color:var(--ink)}
</style>
<body><div class="wrap">
  <h1>ATLAS · Admin</h1>
  <div class="sub">Registered employees · taste-graph console</div>

  <div class="card" id="loginCard" hidden>
    <div style="font-size:14px;margin-bottom:4px">Sign in</div>
    <div class="muted">ATLAS employees only.</div>
    <label>Username</label><input id="u" autocomplete="username" placeholder="adrian / jack">
    <label>Password</label><input id="p" type="password" autocomplete="current-password">
    <div class="row" style="margin-top:16px"><button class="primary" id="loginBtn">Sign in</button></div>
    <div class="err" id="loginErr"></div>
  </div>

  <div id="app" hidden>
    <div class="card">
      <div class="row" style="justify-content:space-between">
        <div><b id="who">—</b> <span class="pill">· signed in</span></div>
        <div class="row">
          <select id="tenant" style="width:180px;padding:9px 11px;background:var(--input);border:1px solid var(--line);border-radius:9px;color:var(--ink);font-size:13px"></select>
          <input id="city" placeholder="City (Miami)" style="width:140px">
          <button class="primary" id="loadBtn">⟳ Load / refresh graph</button>
          <button class="ghost" id="logoutBtn">Sign out</button>
        </div>
      </div>
      <div class="err" id="appMsg"></div>
    </div>
    <div class="card">
      <div class="muted" id="tenantLabel">—</div>
      <h3>Graph totals</h3>
      <div class="grid" id="kpis"></div>
      <div class="two">
        <div><h3>Top artists</h3><div class="bars" id="artists"></div></div>
        <div><h3>Top genres</h3><div class="bars" id="genres"></div></div>
      </div>
      <h3>Recent evidence (writes)</h3>
      <div style="overflow-x:auto"><table id="evtbl"><thead><tr><th>subject</th><th>signal</th><th>provenance</th><th>weight</th><th>when</th></tr></thead><tbody></tbody></table></div>
      <div class="muted" style="margin-top:14px">Tap any tile above to drill into the collected records.</div>
    </div>

    <div class="card" id="explorer" hidden>
      <div class="exhead">
        <h2 id="exTitle">—</h2>
        <div class="row">
          <input id="exSearch" class="search" placeholder="Filter…">
          <button class="ghost" id="exClose">Close</button>
        </div>
      </div>
      <div class="muted" id="exCount" style="margin:8px 0 12px">—</div>
      <div style="overflow-x:auto"><table id="exTbl"><thead></thead><tbody></tbody></table></div>
      <div class="pager">
        <button id="exPrev">‹ Prev</button>
        <span id="exPage">—</span>
        <button id="exNext">Next ›</button>
      </div>
    </div>
  </div>

  <div class="drawer" id="gdraw">
    <div class="panel">
      <div class="exhead"><h2 id="gdTitle">Guest</h2><button class="ghost" id="gdClose">Close</button></div>
      <div id="gdBody"></div>
    </div>
  </div>
</div>
<script>
  var $=function(s){return document.querySelector(s)};
  async function api(path,opts){var r=await fetch(path,Object.assign({headers:{'Content-Type':'application/json'}},opts||{}));var j=null;try{j=await r.json()}catch(e){}; return {ok:r.ok,status:r.status,json:j}}
  function esc(s){return String(s==null?'':s).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}
  function bars(host,rows){var max=Math.max.apply(null,rows.map(function(r){return r.score||0}).concat([1]));
    host.innerHTML=rows.length?rows.map(function(r){var w=Math.round(100*(r.score||0)/max);
      return '<div class="b"><span>'+esc(r.subjectRef)+'</span><span class="tk"><i style="width:'+w+'%"></i></span><span class="n">'+(r.score||0)+'</span></div>'}).join(''):'<div class="muted">none yet</div>'}
  function kpi(k,v,coll,kind,type){
    var attr=coll?(' class="kpi clik" data-coll="'+coll+'"'+(kind?' data-kind="'+kind+'"':'')+(type?' data-type="'+type+'"':'')):' class="kpi"';
    return '<div'+attr+'><div class="k">'+esc(k)+'</div><div class="v">'+esc(v)+'</div>'+(coll?'<div class="go">drill ›</div>':'')+'</div>'}
  function renderGraph(g){
    $('#tenantLabel').textContent='Tenant: '+g.tenant;
    var e=g.entities||{},c=g.counts||{},sj=g.subjects||{};
    $('#kpis').innerHTML=[kpi('Artists',e.artist||0,'entities','artist'),kpi('Genres',sj.genre||0,'affinities',null,'genre'),kpi('Venues',e.venue||0,'entities','venue'),kpi('Events',e.event||0,'entities','event'),
      kpi('Guests',c.guests||0,'guests'),kpi('Consents',c.consents||0,'consents'),kpi('Evidence',c.evidence||0,'evidence'),kpi('Affinities',c.affinities||0,'affinities'),kpi('Crews',c.crews||0,'crews')].join('');
    bars($('#artists'),g.topArtists||[]); bars($('#genres'),g.topGenres||[]);
    $('#evtbl tbody').innerHTML=(g.recentEvidence||[]).map(function(r){return '<tr><td><span class="pill">'+esc(r.subjectType)+'</span> '+esc(r.subjectRef)+'</td><td>'+esc(r.signal)+'</td><td>'+esc(r.provenance)+'</td><td>'+esc(r.weight)+'</td><td>'+esc((r.observedAt||'').slice(0,16).replace('T',' '))+'</td></tr>'}).join('')||'<tr><td colspan="5" class="muted">no evidence yet</td></tr>';
  }

  // ---- drill-down explorer ----
  var ex={name:null,kind:null,type:null,q:'',page:1,pages:1};
  function cell(col,r){
    var v=r[col.key];
    if(col.key==='muted'||col.key==='verified'){return '<span class="chip '+(v?'on':'off')+'">'+(v?'yes':'no')+'</span>'}
    if(col.key==='provisional'){return '<span class="chip '+(v?'off':'on')+'">'+(v?'provisional':'known')+'</span>'}
    if(col.key==='status'){return '<span class="chip '+(v==='active'?'on':'off')+'">'+esc(v)+'</span>'}
    if(col.key==='createdAt'||col.key==='grantedAt'||col.key==='observedAt'){return esc(String(v||'').slice(0,16).replace('T',' '))}
    return esc(v==null?'—':v)}
  function renderCollection(d){
    ex.pages=d.pages; ex.page=d.page;
    $('#exTitle').textContent=d.label;
    $('#exCount').textContent=d.total+' record'+(d.total===1?'':'s')+(ex.q?' matching “'+ex.q+'”':'')+(ex.kind?' · '+ex.kind:'')+(ex.type?' · '+ex.type:'');
    $('#exTbl thead').innerHTML='<tr>'+d.columns.map(function(c){return '<th>'+esc(c.label)+'</th>'}).join('')+'</tr>';
    $('#exTbl tbody').innerHTML=d.rows.length?d.rows.map(function(r){
      var gid=r.guestId||(d.name==='guests'?r.id:null);
      return '<tr'+(gid?' class="clik" data-guest="'+esc(gid)+'"':'')+'>'+d.columns.map(function(c){return '<td>'+cell(c,r)+'</td>'}).join('')+'</tr>'
    }).join(''):'<tr><td colspan="'+d.columns.length+'" class="muted">no records</td></tr>';
    $('#exPage').textContent='Page '+d.page+' / '+d.pages;
    $('#exPrev').disabled=d.page<=1; $('#exNext').disabled=d.page>=d.pages;
  }
  async function loadCollection(){
    var url='/admin/collection?name='+encodeURIComponent(ex.name)+'&tenant='+encodeURIComponent(selTenant())+'&page='+ex.page+'&q='+encodeURIComponent(ex.q)+(ex.kind?'&kind='+encodeURIComponent(ex.kind):'')+(ex.type?'&type='+encodeURIComponent(ex.type):'');
    var r=await api(url);
    if(r.ok){renderCollection(r.json)}else if(r.status===401){show(false)}else{$('#exCount').textContent=(r.json&&r.json.message)||'load failed'}
  }
  function openCollection(name,kind,type){
    ex.name=name; ex.kind=kind||null; ex.type=type||null; ex.q=''; ex.page=1;
    $('#exSearch').value=''; $('#explorer').hidden=false;
    $('#explorer').scrollIntoView({behavior:'smooth',block:'start'});
    loadCollection();
  }
  async function openGuest(id){
    var r=await api('/admin/guest/'+encodeURIComponent(id)+'?tenant='+encodeURIComponent(selTenant()));
    if(!r.ok){return}
    var d=r.json,g=d.guest;
    $('#gdTitle').textContent=g.displayName;
    function rows(arr,f){return arr&&arr.length?arr.map(f).join(''):'<div class="muted">none</div>'}
    $('#gdBody').innerHTML=
      '<dl class="dl"><dt>id</dt><dd>'+esc(g.id)+'</dd><dt>email</dt><dd>'+esc(g.email||'—')+'</dd><dt>phone</dt><dd>'+esc(g.primaryPhone||'—')+'</dd><dt>status</dt><dd>'+(g.provisional?'provisional':'known')+'</dd><dt>first seen</dt><dd>'+esc(String(g.createdAt||'').slice(0,16).replace('T',' '))+'</dd></dl>'+
      '<h3>Identity links ('+d.identity.length+')</h3>'+rows(d.identity,function(l){return '<div class="b" style="font-size:12.5px">'+esc(l.kind)+' <span class="chip '+(l.verified?'on':'off')+'">'+(l.verified?'verified':'unverified')+'</span> <span class="muted">'+esc(l.source||'')+'</span></div>'})+
      '<h3>Consents ('+d.consents.length+')</h3>'+rows(d.consents,function(c){return '<div style="font-size:12.5px;margin:3px 0">'+esc(c.scope)+' · '+esc(c.basis)+(c.connector?' · '+esc(c.connector):'')+' <span class="chip '+(c.revokedAt?'off':'on')+'">'+(c.revokedAt?'revoked':'active')+'</span></div>'})+
      '<h3>Top affinities ('+d.affinities.length+')</h3>'+rows(d.affinities,function(a){return '<div style="font-size:12.5px;margin:3px 0"><span class="pill">'+esc(a.subjectType)+'</span> '+esc(a.subjectRef)+' <span class="n">'+a.score+'</span></div>'})+
      '<h3>Recent evidence ('+d.evidence.length+')</h3>'+rows(d.evidence,function(e){return '<div style="font-size:12px;margin:2px 0;color:var(--mut)">'+esc(e.signal)+' · '+esc(e.subjectType)+' '+esc(e.subjectRef)+' · '+esc(e.provenance)+' <span class="muted">'+esc(String(e.observedAt||'').slice(0,10))+'</span></div>'})+
      '<h3>Crews ('+d.crews.length+')</h3>'+rows(d.crews,function(c){return '<div style="font-size:12.5px">'+esc(c.name)+' <span class="muted">('+esc(c.role)+')</span></div>'})+
      '<h3>Entitlements ('+d.entitlements.length+')</h3>'+rows(d.entitlements,function(t){return '<div style="font-size:12.5px">'+esc(t.kind)+' <span class="chip '+(t.state==='active'?'on':'off')+'">'+esc(t.state)+'</span></div>'});
    $('#gdraw').classList.add('open');
  }
  var searchT=null;
  $('#kpis').addEventListener('click',function(ev){var t=ev.target.closest('.clik');if(t&&t.dataset.coll){openCollection(t.dataset.coll,t.dataset.kind,t.dataset.type)}});
  $('#exTbl').addEventListener('click',function(ev){var t=ev.target.closest('tr.clik');if(t&&t.dataset.guest){openGuest(t.dataset.guest)}});
  $('#exClose').addEventListener('click',function(){$('#explorer').hidden=true});
  $('#exPrev').addEventListener('click',function(){if(ex.page>1){ex.page--;loadCollection()}});
  $('#exNext').addEventListener('click',function(){if(ex.page<ex.pages){ex.page++;loadCollection()}});
  $('#exSearch').addEventListener('input',function(){var v=this.value;clearTimeout(searchT);searchT=setTimeout(function(){ex.q=v;ex.page=1;loadCollection()},260)});
  $('#gdClose').addEventListener('click',function(){$('#gdraw').classList.remove('open')});
  $('#gdraw').addEventListener('click',function(ev){if(ev.target===this){this.classList.remove('open')}});
  function selTenant(){var s=$('#tenant');return s&&s.value?s.value:'all'}
  var tenantsLoaded=false;
  async function initTenants(){if(tenantsLoaded)return;var r=await api('/admin/tenants');var sel=$('#tenant');
    var opts='<option value="all">All tenants</option>';
    if(r.ok&&Array.isArray(r.json)){opts+=r.json.map(function(t){return '<option value="'+esc(t.id)+'">'+esc(t.name)+' ('+esc(t.kind)+')</option>'}).join('')}
    sel.innerHTML=opts; tenantsLoaded=true; sel.addEventListener('change',loadGraph)}
  async function loadGraph(){var r=await api('/admin/graph?tenant='+encodeURIComponent(selTenant()));if(r.ok){renderGraph(r.json);if(!$('#explorer').hidden&&ex.name){ex.page=1;loadCollection()}}else if(r.status===401){show(false)}}
  function show(authed){$('#app').hidden=!authed;$('#loginCard').hidden=authed}
  async function boot(){var s=await api('/admin/session');
    if(!s.json||!s.json.configured){$('#loginCard').hidden=false;$('#loginErr').textContent='Admin login is not configured on this deployment yet.';$('#loginBtn').disabled=true;return}
    if(s.json.authenticated){$('#who').textContent=s.json.user;show(true);initTenants().then(loadGraph)}else{show(false)}}
  $('#loginBtn').addEventListener('click',async function(){var b=this;b.disabled=true;$('#loginErr').textContent='';
    var r=await api('/admin/login',{method:'POST',body:JSON.stringify({username:$('#u').value.trim(),password:$('#p').value})});
    b.disabled=false;
    if(r.ok){$('#who').textContent=r.json.user;show(true);initTenants().then(loadGraph)}else{$('#loginErr').textContent=(r.json&&r.json.message)||'Sign-in failed'}});
  $('#logoutBtn').addEventListener('click',async function(){await api('/admin/logout',{method:'POST'});show(false)});
  $('#loadBtn').addEventListener('click',async function(){var b=this;b.disabled=true;$('#appMsg').textContent='Loading catalog + graph…';
    var r=await api('/admin/load',{method:'POST',body:JSON.stringify({city:($('#city').value.trim()||undefined),tenant:selTenant()})});
    b.disabled=false;
    if(r.ok){renderGraph(r.json.graph);if(!$('#explorer').hidden&&ex.name){loadCollection()}var ing=r.json.ingested||{};var rc=r.json.recomputed;$('#appMsg').textContent='Loaded · '+(ing.created!=null?ing.created+' entities ingested':'catalog refreshed')+(rc!=null?' · '+rc+' affinities recomputed':'')}
    else if(r.status===401){show(false)}else{$('#appMsg').textContent=(r.json&&r.json.message)||'Load failed'}});
  boot();
</script>`;
}

@Module({
  imports: [CatalogIngestModule, TasteModule],
  controllers: [AdminController],
  providers: [AdminService, AdminGuard],
})
export class AdminModule {}
