import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConsentBasis } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

/**
 * Consent purpose-scope audit (privacy / DPO surface). Read-only, tenant-scoped.
 *
 *   GET /v1/consent/audit?staleDays=365
 *
 * Produces a purpose-scope register over ConsentGrant so the DPO can stay ahead
 * of tightening privacy rules: active grants grouped by (scope, basis), a guest
 * count per group, STALE flags for grants granted longer ago than staleDays, and
 * a 'review' flag for any grant whose scope is not in the known allow-list. No
 * writes — this only reads the consent register.
 */

// Default staleness horizon in days when the caller does not pass ?staleDays.
const DEFAULT_STALE_DAYS = 365;

/**
 * Known/expected consent purpose scopes. A grant carrying a scope outside this
 * allow-list is surfaced as 'review' — either a typo, a deprecated purpose, or a
 * scope introduced without updating the register policy. Kept intentionally
 * conservative; extend as new purposes are formally adopted.
 */
export const KNOWN_CONSENT_SCOPES: ReadonlySet<string> = new Set([
  'guest:profile:read',
  'guest:taste:read',
  'guest:contact:marketing',
  'guest:contact:transactional',
  'connector:spotify:read',
  'connector:instagram:read',
  'analytics:aggregate',
]);

/** A grant row as read from the register for auditing. */
export interface AuditGrant {
  guestId: string;
  scope: string;
  basis: ConsentBasis;
  grantedAt: Date;
  revokedAt: Date | null;
}

export type ScopeStatus = 'ok' | 'review' | 'stale';

export interface ScopeRow {
  scope: string;
  basis: ConsentBasis;
  activeGrants: number;
  distinctGuests: number;
  staleGrants: number;
  status: ScopeStatus;
}

export interface ConsentAuditReport {
  tenantId: string;
  generatedForStaleDays: number;
  byScope: ScopeRow[];
  totals: {
    active: number;
    revoked: number;
    stale: number;
    needsReview: number;
  };
}

/** Milliseconds in a day. */
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Pure register fold. Given all grants (active + revoked) for a tenant plus the
 * staleness horizon and a reference "now", produce the purpose-scope register.
 * Kept pure so it is trivially testable and free of clock/DB coupling.
 */
export function buildConsentRegister(
  tenantId: string,
  grants: AuditGrant[],
  staleDays: number,
  now: Date,
): ConsentAuditReport {
  const cutoff = new Date(now.getTime() - staleDays * DAY_MS);

  // Group active grants by (scope, basis). Revoked grants are counted only in
  // the totals summary, never in the per-scope register.
  const groups = new Map<
    string,
    {
      scope: string;
      basis: ConsentBasis;
      activeGrants: number;
      guests: Set<string>;
      staleGrants: number;
    }
  >();

  let active = 0;
  let revoked = 0;
  let stale = 0;

  for (const g of grants) {
    if (g.revokedAt != null) {
      revoked += 1;
      continue;
    }
    active += 1;

    const key = `${g.scope}${g.basis}`;
    let entry = groups.get(key);
    if (!entry) {
      entry = {
        scope: g.scope,
        basis: g.basis,
        activeGrants: 0,
        guests: new Set<string>(),
        staleGrants: 0,
      };
      groups.set(key, entry);
    }
    entry.activeGrants += 1;
    entry.guests.add(g.guestId);

    const isStale = g.grantedAt.getTime() < cutoff.getTime();
    if (isStale) {
      entry.staleGrants += 1;
      stale += 1;
    }
  }

  let needsReview = 0;
  const byScope: ScopeRow[] = [...groups.values()]
    .map((e) => {
      const unknownScope = !KNOWN_CONSENT_SCOPES.has(e.scope);
      // Precedence: an unknown scope always demands review (policy gap) even if
      // it also happens to be stale; otherwise stale grants flag 'stale'.
      let status: ScopeStatus = 'ok';
      if (unknownScope) status = 'review';
      else if (e.staleGrants > 0) status = 'stale';

      if (status === 'review') needsReview += 1;

      return {
        scope: e.scope,
        basis: e.basis,
        activeGrants: e.activeGrants,
        distinctGuests: e.guests.size,
        staleGrants: e.staleGrants,
        status,
      };
    })
    // Stable, useful ordering: scope then basis.
    .sort((a, b) =>
      a.scope === b.scope
        ? a.basis.localeCompare(b.basis)
        : a.scope.localeCompare(b.scope),
    );

  return {
    tenantId,
    generatedForStaleDays: staleDays,
    byScope,
    totals: { active, revoked, stale, needsReview },
  };
}

@Injectable()
export class ConsentAuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Build the purpose-scope consent register for the caller's tenant. Reads
   * every grant (active + revoked) for the tenant and folds it into the report.
   * `staleDays` defaults to DEFAULT_STALE_DAYS and is clamped to a sane range.
   */
  async audit(
    ctx: TenantContext,
    staleDays?: number,
  ): Promise<ConsentAuditReport> {
    const horizon = this.normalizeStaleDays(staleDays);

    const grants = await this.prisma.consentGrant.findMany({
      where: { tenantId: ctx.tenantId },
      select: {
        guestId: true,
        scope: true,
        basis: true,
        grantedAt: true,
        revokedAt: true,
      },
    });

    return buildConsentRegister(ctx.tenantId, grants, horizon, new Date());
  }

  /** Coerce/clamp the ?staleDays query param to a positive integer. */
  private normalizeStaleDays(raw?: number): number {
    if (raw == null || Number.isNaN(raw)) return DEFAULT_STALE_DAYS;
    const n = Math.floor(raw);
    if (n < 1) return 1;
    // Guard against absurd horizons; ~100 years is plenty.
    return Math.min(n, 36_500);
  }
}

@ApiTags('guest:consent')
@Controller()
export class ConsentAuditController {
  constructor(private readonly svc: ConsentAuditService) {}

  /**
   * Purpose-scope consent register / audit for the tenant. Optional `staleDays`
   * (default 365) sets the grant-age horizon beyond which grants are flagged stale.
   */
  @Get('consent/audit')
  @Scopes('guest:consent:read')
  audit(
    @Tenant() ctx: TenantContext,
    @Query('staleDays') staleDays?: string,
  ): Promise<ConsentAuditReport> {
    const parsed =
      staleDays == null || staleDays === '' ? undefined : Number(staleDays);
    return this.svc.audit(ctx, parsed);
  }
}

@Module({
  controllers: [ConsentAuditController],
  providers: [ConsentAuditService],
  exports: [ConsentAuditService],
})
export class ConsentAuditModule {}
