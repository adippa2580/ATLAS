import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

/** How many top affinities the projection summary discloses. */
const PROJECTION_TOP_N = 10;

export class CreateGrantDto {
  /** A guest row in the CALLER's own tenant, consenting to be projected. */
  @IsString()
  guestId!: string;

  /** The venue tenant that may read the projection. */
  @IsString()
  granteeTenantId!: string;

  /** What may be projected. Defaults to the schema default 'affinity:summary'. */
  @IsOptional()
  @IsString()
  scope?: string;
}

/** A single disclosed affinity — deliberately carries no guest/tenant identity. */
export interface ProjectedAffinity {
  subjectType: string;
  subjectRef: string;
  score: number;
}

export interface AffinityProjection {
  /** Echoes the caller's own guest row id — never a foreign-tenant guestId. */
  guestId: string;
  scope: string;
  /** Number of Guest rows on the spine that contributed (a count, not ids). */
  contributingProfiles: number;
  /** Ranked top affinities, mutes excluded. No raw rows, no provenance. */
  top: ProjectedAffinity[];
}

/**
 * Per-venue consented projection of the cross-tenant identity spine. A guest
 * consents (grant) to a specific venue tenant seeing a SCOPED SUMMARY of their
 * affinity aggregated across every tenant they exist in. This service is the
 * ONLY sanctioned cross-tenant intelligence path — every disclosure is gated on
 * a live VenueProjectionGrant.
 */
@Injectable()
export class ProjectionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve a guest (tenant-scoped to ctx) onto the identity spine, minting the
   * spine on first use. Mirrors IdentityService.ensureGlobalGuest and stays
   * append-only: it only ever SETS globalGuestId, never reassigns it.
   */
  private async ensureGlobalGuest(
    ctx: TenantContext,
    guestId: string,
  ): Promise<string> {
    const guest = await this.prisma.guest.findFirst({
      where: { id: guestId, tenantId: ctx.tenantId },
      include: { links: { where: { verified: true } } },
    });
    if (!guest) throw new NotFoundException('Guest not found');
    if (guest.globalGuestId) return guest.globalGuestId;

    const verifiedPairs = guest.links.map((l) => ({
      kind: l.kind,
      valueHash: l.valueHash,
    }));
    if (verifiedPairs.length > 0) {
      const match = await this.prisma.identityLink.findFirst({
        where: {
          verified: true,
          guestId: { not: guestId },
          OR: verifiedPairs,
          guest: { globalGuestId: { not: null } },
        },
        include: { guest: { select: { globalGuestId: true } } },
      });
      if (match?.guest?.globalGuestId) {
        await this.prisma.guest.update({
          where: { id: guestId },
          data: { globalGuestId: match.guest.globalGuestId },
        });
        return match.guest.globalGuestId;
      }
    }

    const spine = await this.prisma.globalGuest.create({ data: {} });
    await this.prisma.guest.update({
      where: { id: guestId },
      data: { globalGuestId: spine.id },
    });
    return spine.id;
  }

  /**
   * The guest (in the caller's tenant) consents to `granteeTenantId` seeing a
   * scoped projection. Idempotent on (globalGuestId, granteeTenantId, scope);
   * re-granting also un-revokes a previously revoked grant.
   */
  async grant(ctx: TenantContext, dto: CreateGrantDto) {
    const globalGuestId = await this.ensureGlobalGuest(ctx, dto.guestId);
    const scope = dto.scope ?? 'affinity:summary';
    return this.prisma.venueProjectionGrant.upsert({
      where: {
        globalGuestId_granteeTenantId_scope: {
          globalGuestId,
          granteeTenantId: dto.granteeTenantId,
          scope,
        },
      },
      create: {
        globalGuestId,
        granteeTenantId: dto.granteeTenantId,
        scope,
      },
      update: { revokedAt: null },
    });
  }

  /**
   * Revoke a grant by id. The grant is scoped to the spine of a guest that
   * belongs to the caller's tenant — a venue cannot revoke a grant it merely
   * benefits from, only the granting side can.
   */
  async revoke(ctx: TenantContext, id: string) {
    const existing = await this.prisma.venueProjectionGrant.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Grant not found');
    // Ownership check: the granting side is a guest in the caller's tenant that
    // sits on this grant's spine.
    const owner = await this.prisma.guest.findFirst({
      where: { tenantId: ctx.tenantId, globalGuestId: existing.globalGuestId },
      select: { id: true },
    });
    if (!owner) throw new ForbiddenException('Not the granting tenant');
    return this.prisma.venueProjectionGrant.update({
      where: { id },
      data: { revokedAt: new Date() },
    });
  }

  /**
   * Read the consented cross-tenant projection for a guest.
   *
   * The caller (`ctx.tenantId`) is the venue GRANTEE. `guestId` is a guest row
   * in the CALLER's own tenant; it is resolved to its spine (globalGuestId) and
   * a live, non-revoked grant to this grantee must exist — otherwise Forbidden.
   *
   * When granted, we aggregate GuestAffinity across ALL Guest rows on the spine
   * (the deliberate, consent-gated cross-tenant read) and return ONLY a derived
   * summary: top-N {subjectType, subjectRef, score}. No raw affinity rows, no
   * foreign-tenant guestIds, and no tenant identifiers are ever disclosed.
   */
  async project(
    ctx: TenantContext,
    guestId: string,
  ): Promise<AffinityProjection> {
    // Resolve the caller's own guest row to its spine. Must already be linked.
    const guest = await this.prisma.guest.findFirst({
      where: { id: guestId, tenantId: ctx.tenantId },
      select: { id: true, globalGuestId: true },
    });
    if (!guest) throw new NotFoundException('Guest not found');
    if (!guest.globalGuestId) {
      // Not on the spine → nothing consented, nothing to project.
      throw new ForbiddenException('No projection grant for this guest');
    }

    // Consent gate: a live grant from this spine to THIS venue tenant.
    const grant = await this.prisma.venueProjectionGrant.findFirst({
      where: {
        globalGuestId: guest.globalGuestId,
        granteeTenantId: ctx.tenantId,
        revokedAt: null,
      },
    });
    if (!grant)
      throw new ForbiddenException('No projection grant for this guest');

    // INTENTIONALLY CROSS-TENANT: this aggregation spans every Guest row on the
    // spine regardless of tenant. It MUST NOT be bound to a single-tenant RLS
    // context — the ONLY thing authorising it is the consent grant checked
    // above. All other reads in this service stay tenant-scoped to ctx.
    const spineGuests = await this.prisma.guest.findMany({
      where: { globalGuestId: guest.globalGuestId },
      select: { id: true },
    });
    const guestIds = spineGuests.map((g) => g.id);

    const affinities = await this.prisma.guestAffinity.findMany({
      where: { guestId: { in: guestIds }, muted: false },
    });

    // Collapse to a summary: sum score per (subjectType, subjectRef). We emit a
    // derived object only — never the raw rows or their owning guestIds/tenants.
    const bySubject = new Map<
      string,
      { subjectType: string; subjectRef: string; score: number }
    >();
    for (const a of affinities) {
      const key = `${a.subjectType}::${a.subjectRef}`;
      const existing = bySubject.get(key);
      if (existing) {
        existing.score += a.score;
      } else {
        bySubject.set(key, {
          subjectType: String(a.subjectType),
          subjectRef: a.subjectRef,
          score: a.score,
        });
      }
    }

    const top = Array.from(bySubject.values())
      .sort((x, y) => y.score - x.score)
      .slice(0, PROJECTION_TOP_N);

    return {
      guestId: guest.id, // caller's own row id — safe to echo
      scope: grant.scope,
      contributingProfiles: guestIds.length,
      top,
    };
  }
}

@ApiTags('projection')
@Controller('projection')
export class ProjectionController {
  constructor(private readonly projection: ProjectionService) {}

  /** A guest consents to a venue tenant seeing their projection. */
  @Post('grants')
  @Scopes('guest:consent:write')
  grant(@Tenant() ctx: TenantContext, @Body() dto: CreateGrantDto) {
    return this.projection.grant(ctx, dto);
  }

  /** Withdraw a previously issued grant. */
  @Delete('grants/:id')
  @Scopes('guest:consent:write')
  revoke(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.projection.revoke(ctx, id);
  }

  /** Venue grantee reads the consented cross-tenant summary for a guest. */
  @Get(':guestId')
  @Scopes('mkt:reporting:read')
  project(@Tenant() ctx: TenantContext, @Param('guestId') guestId: string) {
    return this.projection.project(ctx, guestId);
  }
}

@Module({
  controllers: [ProjectionController],
  providers: [ProjectionService],
  exports: [ProjectionService],
})
export class ProjectionModule {}
