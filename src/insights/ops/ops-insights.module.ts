import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { BookingStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Ops insight endpoints (Team INS-OPS) — read-only, tenant-scoped surfaces over
 * the ops + trust + taste pillars. Four cards from docs/analytics/cross-pillar-insights.md:
 *   F  GET /insights/minspend-realization  — is minSpend mis-set vs realized tabs?
 *   D  GET /insights/no-show-risk           — per-booking no-show risk + deposit tier
 *   VIP GET /insights/doorlist              — "who's walking in tonight" host card
 *   H  GET /insights/product-mix            — the night's SKU/category spend mix
 *
 * Money is always integer minor units (cents), matching Tab.total / Inventory.minSpend.
 */

// ---------------------------------------------------------------------------
// Pure helpers (kept in-file, no external test harness)
// ---------------------------------------------------------------------------

type LineItem = { name: string; amount: number };

/** Median of a numeric list (cents). Returns 0 for empty input. */
function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/** UTC [start, end) day window for a YYYY-MM-DD string. */
function dayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** ISO year-week label ("2026-W30") for weekly trend bucketing (UTC). */
function isoYearWeek(d: Date): string {
  const date = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0 … Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // shift to the ISO Thursday
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week =
    1 +
    Math.round(
      (date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000),
    );
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * A single TrustEvent's signed contribution: no_show erodes trust (negative),
 * everything else (positive, loyalty, ...) builds it (positive).
 */
function signedTrustWeight(kind: string, weight: number): number {
  return kind === 'no_show' ? -Math.abs(weight) : Math.abs(weight);
}

/**
 * Features for the no-show risk model (Insight D). All grounded in real columns.
 */
export interface NoShowFeatures {
  trustNet: number; // Σ signed TrustEvent weight for the guest (higher = safer)
  priorCancelled: number; // count of this guest's prior cancelled bookings
  leadTimeHours: number; // Booking.date - Booking.createdAt, in hours
  hasDeposit: boolean; // is a deposit set on the booked Inventory?
  partySize: number;
  provisional: boolean; // unmerged / provisional identity
}

/**
 * Pure no-show risk score in [0..100]. Higher = more likely to no-show.
 *
 * base 30
 *   - trust:    safe history pulls risk down, no-show history pushes it up
 *               (-4 per net trust point, clamped to ±24)
 *   + cancels:  +8 per prior cancelled booking, capped at +24
 *   + leadTime: cold long-lead holds drift; +0.5/hr beyond 72h, capped at +15
 *   - deposit:  a deposit already on the table de-risks it, -10
 *   + party:    +2 per head above 4, capped at +16
 *   + prov:     +12 if the identity is still provisional (D is gated on merge)
 * result clamped to [0..100].
 */
export function riskScore(f: NoShowFeatures): number {
  let score = 30;

  const trustAdj = Math.max(-24, Math.min(24, -f.trustNet * 4));
  score += trustAdj;

  score += Math.min(24, Math.max(0, f.priorCancelled) * 8);

  const longLeadHours = Math.max(0, f.leadTimeHours - 72);
  score += Math.min(15, longLeadHours * 0.5);

  if (f.hasDeposit) score -= 10;

  score += Math.min(16, Math.max(0, f.partySize - 4) * 2);

  if (f.provisional) score += 12;

  return Math.round(Math.max(0, Math.min(100, score)));
}

/** Map a risk score to a deposit tier the floor can auto-apply on held->confirmed. */
function depositTier(score: number): 'waive' | 'standard' | 'full' {
  if (score < 25) return 'waive';
  if (score < 60) return 'standard';
  return 'full';
}

/**
 * Coarse SKU->category bucket for product-mix (Insight H). Order matters:
 * champagne before wine, tequila before spirit. Case-insensitive substring match.
 */
export function categorizeSku(
  name: string,
):
  | 'champagne'
  | 'tequila'
  | 'spirit'
  | 'wine'
  | 'beer'
  | 'cocktail'
  | 'na'
  | 'other' {
  const n = (name || '').toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => n.includes(k));

  if (
    has(
      'champagne',
      'champ',
      'moet',
      'moët',
      'veuve',
      'dom perignon',
      'dom pérignon',
      'cristal',
      'ace of spades',
      'armand',
      'brut',
      'prosecco',
      'sparkling',
    )
  )
    return 'champagne';
  if (
    has(
      'tequila',
      'mezcal',
      'don julio',
      'patron',
      'patrón',
      'casamigos',
      'clase azul',
      'espolon',
    )
  )
    return 'tequila';
  if (
    has(
      'vodka',
      'whiskey',
      'whisky',
      'bourbon',
      'scotch',
      'gin',
      'rum',
      'cognac',
      'hennessy',
      'grey goose',
      'belvedere',
      'ciroc',
      'johnnie walker',
      'macallan',
    )
  )
    return 'spirit';
  if (
    has(
      'wine',
      'rosé',
      'rose',
      'cabernet',
      'merlot',
      'chardonnay',
      'pinot',
      'sauvignon',
      'malbec',
      'riesling',
    )
  )
    return 'wine';
  if (has('beer', 'lager', 'ipa', 'pilsner', 'corona', 'heineken', 'stella'))
    return 'beer';
  if (
    has(
      'cocktail',
      'margarita',
      'martini',
      'mojito',
      'negroni',
      'old fashioned',
      'spritz',
      'daiquiri',
      'paloma',
    )
  )
    return 'cocktail';
  if (
    has(
      'water',
      'soda',
      'coke',
      'cola',
      'juice',
      'red bull',
      'redbull',
      'mixer',
      'lemonade',
      'tonic',
      'non-alc',
      'nonalc',
    )
  )
    return 'na';
  return 'other';
}

/** Defensive read of Tab.lineItems (Prisma Json) into a typed array. */
function readLineItems(raw: unknown): LineItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { name?: unknown; amount?: unknown }[])
    .filter((li) => li && typeof li === 'object')
    .map((li) => ({
      name: typeof li.name === 'string' ? li.name : '',
      amount: typeof li.amount === 'number' ? li.amount : 0,
    }));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class OpsInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insight F — minSpend realization per table. Compares Inventory.minSpend to
   * the distribution of realized Tab.total on that table's bookings.
   */
  async minspendRealization(ctx: TenantContext) {
    const t = ctx.tenantId;
    const tables = await this.prisma.inventory.findMany({
      where: { tenantId: t, kind: 'table' },
      include: {
        bookings: {
          where: { tenantId: t },
          include: { tab: { select: { total: true } } },
        },
      },
    });

    const rows = tables.map((inv) => {
      const tabTotals = inv.bookings
        .map((b) => b.tab?.total)
        .filter((v): v is number => typeof v === 'number');
      const bookingCount = tabTotals.length;
      const medianTabCents = median(tabTotals);
      const minSpendCents = inv.minSpend ?? null;

      let pctClearingMin: number | null = null;
      if (minSpendCents != null && bookingCount > 0) {
        const cleared = tabTotals.filter((v) => v >= minSpendCents).length;
        pctClearingMin = Math.round((cleared / bookingCount) * 100) / 100;
      }

      // underpriced: median tab runs well above the minimum -> money left on the
      // table. overpriced: few tabs clear the minimum -> it may be deterring bookings.
      let flag: 'underpriced' | 'overpriced' | 'balanced' = 'balanced';
      if (minSpendCents != null && bookingCount > 0) {
        if (medianTabCents >= minSpendCents * 1.5) flag = 'underpriced';
        else if (pctClearingMin != null && pctClearingMin < 0.5)
          flag = 'overpriced';
      }

      return {
        inventoryId: inv.id,
        label: inv.label ?? null,
        minSpendCents,
        medianTabCents,
        pctClearingMin,
        bookingCount,
        flag,
      };
    });

    return { tenantId: t, tables: rows };
  }

  /**
   * Insight D — no-show risk for upcoming bookings on a given date. Scores each
   * held/confirmed booking from grounded trust, cancel-history, lead-time,
   * deposit, party-size and identity features.
   */
  async noShowRisk(ctx: TenantContext, dateStr: string) {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);

    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        date: { gte: start, lt: end },
        status: { in: ['held', 'confirmed'] },
      },
      include: {
        guest: { select: { id: true, displayName: true, provisional: true } },
        inventory: { select: { deposit: true, label: true } },
      },
    });

    const guestIds = [...new Set(bookings.map((b) => b.guestId))];

    // Per-guest trust net (signed) and prior-cancelled counts.
    const [trustEvents, cancelledGroups] = await Promise.all([
      guestIds.length
        ? this.prisma.trustEvent.findMany({
            where: { tenantId: t, guestId: { in: guestIds } },
            select: { guestId: true, kind: true, weight: true },
          })
        : Promise.resolve([]),
      guestIds.length
        ? this.prisma.booking.groupBy({
            by: ['guestId'],
            where: {
              tenantId: t,
              guestId: { in: guestIds },
              status: 'cancelled',
            },
            _count: { _all: true },
          })
        : Promise.resolve(
            [] as { guestId: string; _count: { _all: number } }[],
          ),
    ]);

    const trustNetByGuest = new Map<string, number>();
    for (const ev of trustEvents) {
      trustNetByGuest.set(
        ev.guestId,
        (trustNetByGuest.get(ev.guestId) ?? 0) +
          signedTrustWeight(ev.kind, ev.weight),
      );
    }
    const cancelledByGuest = new Map<string, number>();
    for (const g of cancelledGroups) {
      cancelledByGuest.set(g.guestId, g._count._all);
    }

    const scored = bookings.map((b) => {
      const trustNet = trustNetByGuest.get(b.guestId) ?? 0;
      const priorCancelled = cancelledByGuest.get(b.guestId) ?? 0;
      const leadTimeHours =
        (b.date.getTime() - b.createdAt.getTime()) / (60 * 60 * 1000);
      const hasDeposit = (b.inventory?.deposit ?? 0) > 0;
      const features: NoShowFeatures = {
        trustNet,
        priorCancelled,
        leadTimeHours,
        hasDeposit,
        partySize: b.partySize,
        provisional: b.guest?.provisional ?? true,
      };
      const score = riskScore(features);
      return {
        bookingId: b.id,
        guestId: b.guestId,
        displayName: b.guest?.displayName ?? null,
        status: b.status,
        partySize: b.partySize,
        table: b.inventory?.label ?? null,
        riskScore: score,
        suggestedDepositTier: depositTier(score),
        factors: {
          trustNet,
          priorCancelled,
          leadTimeHours: Math.round(leadTimeHours * 10) / 10,
          hasDeposit,
          partySize: b.partySize,
          provisional: features.provisional,
        },
      };
    });

    scored.sort((a, b) => b.riskScore - a.riskScore);
    return { tenantId: t, date: dateStr, bookings: scored };
  }

  /**
   * VIP "who's walking in tonight" — one card per confirmed/seated party for a
   * venue+date, enriched with lifetime spend, top taste, trust and entitlements.
   */
  async doorlist(ctx: TenantContext, venueId: string, dateStr: string) {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);

    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId,
        date: { gte: start, lt: end },
        status: { in: ['confirmed', 'seated'] },
      },
      include: {
        guest: { select: { id: true, displayName: true } },
      },
    });

    const guestIds = [...new Set(bookings.map((b) => b.guestId))];
    if (guestIds.length === 0) {
      return { tenantId: t, venueId, date: dateStr, cards: [] };
    }

    const [lifetimeBookings, affinities, trustEvents, entitlementGroups] =
      await Promise.all([
        // Lifetime tab: every booking these guests hold, with its tab total.
        this.prisma.booking.findMany({
          where: { tenantId: t, guestId: { in: guestIds } },
          select: { guestId: true, tab: { select: { total: true } } },
        }),
        this.prisma.guestAffinity.findMany({
          where: { tenantId: t, guestId: { in: guestIds }, muted: false },
          orderBy: { score: 'desc' },
          select: { guestId: true, subjectRef: true, score: true },
        }),
        this.prisma.trustEvent.findMany({
          where: { tenantId: t, guestId: { in: guestIds } },
          select: { guestId: true, kind: true, weight: true },
        }),
        this.prisma.entitlement.groupBy({
          by: ['guestId'],
          where: { tenantId: t, guestId: { in: guestIds }, state: 'active' },
          _count: { _all: true },
        }),
      ]);

    const lifetimeByGuest = new Map<string, number>();
    for (const b of lifetimeBookings) {
      lifetimeByGuest.set(
        b.guestId,
        (lifetimeByGuest.get(b.guestId) ?? 0) + (b.tab?.total ?? 0),
      );
    }

    const affinitiesByGuest = new Map<string, string[]>();
    for (const a of affinities) {
      const list = affinitiesByGuest.get(a.guestId) ?? [];
      if (list.length < 3) list.push(a.subjectRef);
      affinitiesByGuest.set(a.guestId, list);
    }

    const trustByGuest = new Map<string, number>();
    for (const ev of trustEvents) {
      trustByGuest.set(
        ev.guestId,
        (trustByGuest.get(ev.guestId) ?? 0) +
          signedTrustWeight(ev.kind, ev.weight),
      );
    }

    const entByGuest = new Map<string, number>();
    for (const g of entitlementGroups) {
      entByGuest.set(g.guestId, g._count._all);
    }

    const cards = bookings.map((b) => ({
      bookingId: b.id,
      guestId: b.guestId,
      displayName: b.guest?.displayName ?? null,
      partySize: b.partySize,
      lifetimeTabCents: lifetimeByGuest.get(b.guestId) ?? 0,
      topAffinities: affinitiesByGuest.get(b.guestId) ?? [],
      trustNet: trustByGuest.get(b.guestId) ?? 0,
      activeEntitlements: entByGuest.get(b.guestId) ?? 0,
    }));

    cards.sort((a, b) => b.lifetimeTabCents - a.lifetimeTabCents);
    return { tenantId: t, venueId, date: dateStr, cards };
  }

  /**
   * Insight H — the night's product mix. Aggregates Tab.lineItems across a
   * venue+date's bookings into category buckets, read straight from the JSON.
   */
  async productMix(ctx: TenantContext, venueId: string, dateStr: string) {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);

    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId,
        date: { gte: start, lt: end },
      },
      select: { tab: { select: { lineItems: true } } },
    });

    const buckets = new Map<
      string,
      { totalCents: number; itemCount: number }
    >();
    for (const b of bookings) {
      const items = readLineItems(b.tab?.lineItems as unknown);
      for (const li of items) {
        const cat = categorizeSku(li.name);
        const cur = buckets.get(cat) ?? { totalCents: 0, itemCount: 0 };
        cur.totalCents += li.amount;
        cur.itemCount += 1;
        buckets.set(cat, cur);
      }
    }

    const mix = [...buckets.entries()]
      .map(([category, v]) => ({
        category,
        totalCents: v.totalCents,
        itemCount: v.itemCount,
      }))
      .sort((a, b) => b.totalCents - a.totalCents);

    return { tenantId: t, venueId, date: dateStr, mix };
  }

  /**
   * Coverage-gap analysis — the identity pillar's largest negative driver. Over
   * attended bookings (seated/closed), what share are still un-enriched
   * (provisional identity)? Broken down by venue and trended by ISO week, plus
   * the number of walk-ins the door has instrumented and the standing
   * provisional backlog. Grounded entirely in Booking + Guest +
   * BookingStatusEvent — no synthetic numbers.
   */
  async coverageGap(ctx: TenantContext, venueId?: string) {
    const t = ctx.tenantId;
    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        ...(venueId ? { venueId } : {}),
        status: { in: [BookingStatus.seated, BookingStatus.closed] },
      },
      select: {
        venueId: true,
        date: true,
        guest: { select: { provisional: true } },
      },
    });

    const isUnenriched = (b: (typeof bookings)[number]) =>
      b.guest?.provisional ?? true;
    const total = bookings.length;
    const unenriched = bookings.filter(isUnenriched).length;
    const enriched = total - unenriched;
    const pct = (part: number, whole: number) =>
      whole ? Math.round((100 * part) / whole) : null;
    const coveragePct = pct(enriched, total);

    // Per-venue split, worst gap first.
    const vAgg = new Map<string, { total: number; unenriched: number }>();
    for (const b of bookings) {
      const cur = vAgg.get(b.venueId) ?? { total: 0, unenriched: 0 };
      cur.total += 1;
      if (isUnenriched(b)) cur.unenriched += 1;
      vAgg.set(b.venueId, cur);
    }
    const byVenue = [...vAgg.entries()]
      .map(([vid, v]) => ({
        venueId: vid,
        total: v.total,
        unenriched: v.unenriched,
        coveragePct: pct(v.total - v.unenriched, v.total),
      }))
      .sort((a, b) => b.unenriched - a.unenriched);

    // Weekly coverage trend, oldest → newest.
    const wAgg = new Map<string, { total: number; enriched: number }>();
    for (const b of bookings) {
      const key = isoYearWeek(b.date);
      const cur = wAgg.get(key) ?? { total: 0, enriched: 0 };
      cur.total += 1;
      if (!isUnenriched(b)) cur.enriched += 1;
      wAgg.set(key, cur);
    }
    const trend = [...wAgg.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, v]) => ({
        week,
        total: v.total,
        coveragePct: pct(v.enriched, v.total),
      }));

    const [walkInsCaptured, provisionalBacklog] = await Promise.all([
      this.prisma.bookingStatusEvent.count({
        where: { tenantId: t, reason: 'walk-in' },
      }),
      this.prisma.guest.count({ where: { tenantId: t, provisional: true } }),
    ]);

    return {
      tenantId: t,
      venueId: venueId ?? null,
      total,
      enriched,
      unenriched,
      coveragePct,
      gapPct: coveragePct === null ? null : 100 - coveragePct,
      walkInsCaptured,
      provisionalBacklog,
      byVenue,
      trend,
    };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('insights')
@Controller('insights')
export class OpsInsightsController {
  constructor(private readonly svc: OpsInsightsService) {}

  /** Insight F — minSpend realization per table. */
  @Get('minspend-realization')
  @Scopes('mkt:reporting:read')
  minspendRealization(@Tenant() ctx: TenantContext) {
    return this.svc.minspendRealization(ctx);
  }

  /** Insight D — no-show risk + suggested deposit tier for a date's bookings. */
  @Get('no-show-risk')
  @Scopes('mkt:reporting:read')
  noShowRisk(@Tenant() ctx: TenantContext, @Query('date') date: string) {
    return this.svc.noShowRisk(ctx, date);
  }

  /** VIP — "who's walking in tonight" door list for a venue+date. */
  @Get('doorlist')
  @Scopes('mkt:reporting:read')
  doorlist(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.doorlist(ctx, venueId, date);
  }

  /** Insight H — the night's product/category spend mix for a venue+date. */
  @Get('product-mix')
  @Scopes('mkt:reporting:read')
  productMix(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.productMix(ctx, venueId, date);
  }

  /**
   * Coverage-gap analysis — un-enriched (provisional) share of attended
   * bookings, by venue and by week, with walk-in capture + provisional backlog.
   * Optional `venueId` narrows to one venue. Backs the identity pillar's
   * "Coverage gap analysis" drill and the door walk-in lever.
   */
  @Get('coverage-gap')
  @Scopes('mkt:reporting:read')
  coverageGap(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId?: string,
  ) {
    return this.svc.coverageGap(ctx, venueId);
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@Module({
  controllers: [OpsInsightsController],
  providers: [OpsInsightsService],
})
export class OpsInsightsModule {}
