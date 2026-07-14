import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { IdentityLinkKind } from '@prisma/client';

/**
 * Revenue & identity insight endpoints (read-only, tenant-scoped).
 *
 * Implements three cross-pillar joins from docs/analytics/cross-pillar-insights.md:
 *   - Insight B  -> GET /insights/identity-coverage (dark revenue / match-rate / reach ceiling)
 *   - Insight E  -> GET /insights/at-risk           (silent whales: high spend + rising lapse)
 *   - Insight G  -> GET /insights/attribution-ltv   (lifetime attribution by channel)
 *
 * Money is integer minor units (cents) everywhere; values are returned raw (unformatted).
 */

const REACHABLE_LINK_KINDS: IdentityLinkKind[] = [
  IdentityLinkKind.phone,
  IdentityLinkKind.email,
  IdentityLinkKind.wallet,
];

@Injectable()
export class RevenueInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Insight B: identity coverage ---------------------------------------
  async identityCoverage(ctx: TenantContext) {
    const t = ctx.tenantId;

    const [
      guestCount,
      totalAgg,
      darkAgg,
      matchedGuestCount,
      reachableGuestCount,
      verifiedLinks,
    ] = await Promise.all([
      this.prisma.guest.count({ where: { tenantId: t } }),
      // Total realized POS spend across the tenant.
      this.prisma.tab.aggregate({
        where: { tenantId: t },
        _sum: { total: true },
      }),
      // "Dark revenue": spend sitting on bookings whose guest is still provisional
      // (Tab.bookingId -> Booking.guestId -> Guest.provisional).
      this.prisma.tab.aggregate({
        where: { tenantId: t, booking: { guest: { provisional: true } } },
        _sum: { total: true },
      }),
      // Guests with >=1 verified identity link (match-rate numerator).
      this.prisma.guest.count({
        where: { tenantId: t, links: { some: { verified: true } } },
      }),
      // Reach ceiling: a verified reachable link kind AND an active (un-revoked) consent.
      this.prisma.guest.count({
        where: {
          tenantId: t,
          links: {
            some: {
              verified: true,
              kind: { in: REACHABLE_LINK_KINDS },
            },
          },
          consents: { some: { revokedAt: null } },
        },
      }),
      // Per-kind coverage: verified links, deduped to distinct guests in JS.
      this.prisma.identityLink.findMany({
        where: { tenantId: t, verified: true },
        select: { guestId: true, kind: true },
      }),
    ]);

    // Distinct-guest coverage per IdentityLink.kind.
    const guestsByKind = new Map<string, Set<string>>();
    for (const link of verifiedLinks) {
      let set = guestsByKind.get(link.kind);
      if (!set) {
        set = new Set<string>();
        guestsByKind.set(link.kind, set);
      }
      set.add(link.guestId);
    }
    const kindCoverage: Record<string, { guests: number; pct: number }> = {};
    for (const [kind, set] of guestsByKind) {
      kindCoverage[kind] = {
        guests: set.size,
        pct: guestCount > 0 ? set.size / guestCount : 0,
      };
    }

    const totalRevenueCents = totalAgg._sum.total ?? 0;
    const darkRevenueCents = darkAgg._sum.total ?? 0;

    return {
      tenantId: t,
      guestCount,
      darkRevenueCents,
      totalRevenueCents,
      darkRevenuePct:
        totalRevenueCents > 0 ? darkRevenueCents / totalRevenueCents : 0,
      matchRate: guestCount > 0 ? matchedGuestCount / guestCount : 0,
      matchedGuestCount,
      reachablePct: guestCount > 0 ? reachableGuestCount / guestCount : 0,
      reachableGuestCount,
      kindCoverage,
    };
  }

  // --- Insight E: silent whales (high value + decaying frequency) ----------
  async atRisk(ctx: TenantContext, days: number, limit: number) {
    const t = ctx.tenantId;
    const now = Date.now();
    const MS_PER_DAY = 86_400_000;

    // Per-guest money + recency: pull each booking's guest, date and tab total.
    const bookings = await this.prisma.booking.findMany({
      where: { tenantId: t },
      select: {
        guestId: true,
        date: true,
        guest: { select: { displayName: true } },
        tab: { select: { total: true } },
      },
    });

    // Top GuestAffinity score per guest (venue/any subject) — the "still wants us" signal.
    const affinityAgg = await this.prisma.guestAffinity.groupBy({
      by: ['guestId'],
      where: { tenantId: t },
      _max: { score: true },
    });
    const topAffinityByGuest = new Map<string, number>();
    for (const row of affinityAgg) {
      topAffinityByGuest.set(row.guestId, row._max.score ?? 0);
    }

    type Acc = {
      guestId: string;
      displayName: string | null;
      lifetimeSpendCents: number;
      lastVisit: Date;
    };
    const byGuest = new Map<string, Acc>();
    for (const b of bookings) {
      const spend = b.tab?.total ?? 0;
      const existing = byGuest.get(b.guestId);
      if (!existing) {
        byGuest.set(b.guestId, {
          guestId: b.guestId,
          displayName: b.guest?.displayName ?? null,
          lifetimeSpendCents: spend,
          lastVisit: b.date,
        });
      } else {
        existing.lifetimeSpendCents += spend;
        if (b.date > existing.lastVisit) existing.lastVisit = b.date;
      }
    }

    const guests = [...byGuest.values()];

    // High-spend threshold = 75th percentile of lifetime spend across booked guests.
    // (Top quartile = "whale"; combined with lapse this is the dangerous quadrant.)
    const p75 = percentile(
      guests.map((g) => g.lifetimeSpendCents),
      0.75,
    );

    const ranked = guests
      .map((g) => {
        const daysSince = Math.floor(
          (now - g.lastVisit.getTime()) / MS_PER_DAY,
        );
        return {
          guestId: g.guestId,
          displayName: g.displayName,
          lifetimeSpendCents: g.lifetimeSpendCents,
          lastVisit: g.lastVisit,
          daysSince,
          topAffinity: topAffinityByGuest.get(g.guestId) ?? 0,
        };
      })
      // Dangerous quadrant: top-percentile spend AND lapsing beyond the threshold.
      .filter((g) => g.lifetimeSpendCents >= p75 && g.daysSince >= days)
      // Rank by trailing spend x lapse (proxy for "value at risk").
      .sort(
        (a, b) =>
          b.lifetimeSpendCents * b.daysSince -
          a.lifetimeSpendCents * a.daysSince,
      )
      .slice(0, limit);

    return {
      tenantId: t,
      daysThreshold: days,
      spendThresholdCents: p75,
      guestsConsidered: guests.length,
      atRisk: ranked,
    };
  }

  // --- Insight G: lifetime attribution by channel --------------------------
  async attributionLtv(ctx: TenantContext) {
    const t = ctx.tenantId;

    const [links, campaigns, attributedBookings, allBookings] =
      await Promise.all([
        this.prisma.attributionLink.findMany({
          where: { tenantId: t },
          select: { id: true, campaignId: true },
        }),
        this.prisma.campaign.findMany({
          where: { tenantId: t },
          select: { id: true, channel: true },
        }),
        // Attributed (first-touch) bookings: attributionId -> AttributionLink.id.
        this.prisma.booking.findMany({
          where: { tenantId: t, attributionId: { not: null } },
          select: {
            guestId: true,
            attributionId: true,
            date: true,
            tab: { select: { total: true } },
          },
        }),
        // All bookings, to compute each acquired guest's full LTV across ALL bookings.
        this.prisma.booking.findMany({
          where: { tenantId: t },
          select: { guestId: true, tab: { select: { total: true } } },
        }),
      ]);

    const channelByLinkId = new Map<string, string>();
    const channelByCampaignId = new Map<string, string>();
    for (const c of campaigns) channelByCampaignId.set(c.id, c.channel);
    for (const l of links) {
      const channel =
        (l.campaignId && channelByCampaignId.get(l.campaignId)) || 'unattributed';
      channelByLinkId.set(l.id, channel);
    }

    // Lifetime spend per guest across ALL their bookings (survives the merge).
    const lifetimeByGuest = new Map<string, number>();
    for (const b of allBookings) {
      lifetimeByGuest.set(
        b.guestId,
        (lifetimeByGuest.get(b.guestId) ?? 0) + (b.tab?.total ?? 0),
      );
    }

    // Assign each acquired guest to the channel of their EARLIEST attributed booking
    // (first touch), summing that booking's revenue as first-booking revenue.
    type FirstTouch = { channel: string; date: Date };
    const firstTouchByGuest = new Map<string, FirstTouch>();
    const firstBookingRevenueByChannel = new Map<string, number>();
    for (const b of attributedBookings) {
      const channel = b.attributionId
        ? channelByLinkId.get(b.attributionId) ?? 'unattributed'
        : 'unattributed';
      firstBookingRevenueByChannel.set(
        channel,
        (firstBookingRevenueByChannel.get(channel) ?? 0) + (b.tab?.total ?? 0),
      );
      const prior = firstTouchByGuest.get(b.guestId);
      if (!prior || b.date < prior.date) {
        firstTouchByGuest.set(b.guestId, { channel, date: b.date });
      }
    }

    // Aggregate acquired guests + lifetime revenue per channel (guest counted once,
    // against their first-touch channel).
    const acquiredByChannel = new Map<string, Set<string>>();
    const lifetimeByChannel = new Map<string, number>();
    for (const [guestId, ft] of firstTouchByGuest) {
      let set = acquiredByChannel.get(ft.channel);
      if (!set) {
        set = new Set<string>();
        acquiredByChannel.set(ft.channel, set);
      }
      set.add(guestId);
      lifetimeByChannel.set(
        ft.channel,
        (lifetimeByChannel.get(ft.channel) ?? 0) +
          (lifetimeByGuest.get(guestId) ?? 0),
      );
    }

    const channels = new Set<string>([
      ...acquiredByChannel.keys(),
      ...firstBookingRevenueByChannel.keys(),
    ]);
    const byChannel = [...channels]
      .map((channel) => {
        const acquiredGuests = acquiredByChannel.get(channel)?.size ?? 0;
        const lifetimeRevenueCents = lifetimeByChannel.get(channel) ?? 0;
        const firstBookingRevenueCents =
          firstBookingRevenueByChannel.get(channel) ?? 0;
        return {
          channel,
          acquiredGuests,
          firstBookingRevenueCents,
          lifetimeRevenueCents,
          ltvMultiple:
            firstBookingRevenueCents > 0
              ? lifetimeRevenueCents / firstBookingRevenueCents
              : null,
        };
      })
      .sort((a, b) => b.lifetimeRevenueCents - a.lifetimeRevenueCents);

    return { tenantId: t, byChannel };
  }
}

/** Nearest-rank percentile over a numeric array; 0 for an empty set. */
function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil(q * sorted.length) - 1),
  );
  return sorted[idx];
}

@ApiTags('insights')
@Controller('insights')
export class RevenueInsightsController {
  constructor(private readonly insights: RevenueInsightsService) {}

  /** Insight B — dark revenue, identity match-rate, and reach ceiling. */
  @Get('identity-coverage')
  @Scopes('mkt:reporting:read')
  identityCoverage(@Tenant() ctx: TenantContext) {
    return this.insights.identityCoverage(ctx);
  }

  /** Insight E — silent whales: top-spend guests whose visits are lapsing. */
  @Get('at-risk')
  @Scopes('mkt:reporting:read')
  atRisk(
    @Tenant() ctx: TenantContext,
    @Query('days') days?: string,
    @Query('limit') limit?: string,
  ) {
    const daysThreshold = clampInt(days, 60, 0, 3650);
    const topN = clampInt(limit, 20, 1, 500);
    return this.insights.atRisk(ctx, daysThreshold, topN);
  }

  /** Insight G — lifetime (all-bookings) revenue attribution grouped by channel. */
  @Get('attribution-ltv')
  @Scopes('mkt:reporting:read')
  attributionLtv(@Tenant() ctx: TenantContext) {
    return this.insights.attributionLtv(ctx);
  }
}

/** Parse a query string to an int within [min, max], falling back to a default. */
function clampInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

@Module({
  controllers: [RevenueInsightsController],
  providers: [RevenueInsightsService],
})
export class RevenueInsightsModule {}
