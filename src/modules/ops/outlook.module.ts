import {
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Event Outlook (rules engine v1) — ported from the 2026-07-23 Supabase design
 * spike; MVP subsystem 8. Scores a (venue, night) 0–100 from seven weighted,
 * fully-explainable factors computed off data the platform already holds:
 *
 *   demand pace        0.20  tonight's booking count vs same-weekday baseline
 *   revenue / margin   0.20  projected min-spend vs same-weekday tab baseline
 *   inventory yield    0.15  share of the venue's inventory units booked
 *   audience quality   0.15  mean (non-muted) affinity of tonight's guests
 *   payment certainty  0.10  share of tonight's payments succeeded / held
 *   marketing response 0.10  share of tonight's bookings carrying attribution
 *   ops readiness      0.10  share of tonight's bookings past `held`
 *
 * Every factor is 0–1 with a NEUTRAL 0.5 fallback when its inputs don't exist
 * yet (no baseline, no bookings, no inventory) — a venue with no history scores
 * 50, not 0. The persisted `factors` JSON carries the per-factor breakdown AND
 * the raw inputs, so every score is explainable after the fact;
 * `weightsVersion` pins the rule set so recomputes stay comparable. Scores are
 * natural proposal sources for the operator action ledger (actions.module).
 */
export const OUTLOOK_WEIGHTS = {
  demandPace: 0.2,
  revenueMargin: 0.2,
  inventoryYield: 0.15,
  audienceQuality: 0.15,
  paymentCertainty: 0.1,
  marketingResponse: 0.1,
  opsReadiness: 0.1,
} as const;

export const OUTLOOK_WEIGHTS_VERSION = 'v1-20/20/15/15/10/10/10';

export type OutlookFactors = Record<keyof typeof OUTLOOK_WEIGHTS, number>;

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Score a ratio r = actual / baseline so r=0 → 0, r=1 (on baseline) → 0.5 and
 * r>=2 (double the baseline) → 1. Linear in between, clamped.
 */
function ratioScore(r: number): number {
  return clamp01(r / 2);
}

/** UTC [start, end) day window for a YYYY-MM-DD string (mirrors ops-insights). */
function dayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** Weighted composite over the seven factors, rounded to 2dp on a 0–100 scale. */
export function computeOutlookScore(factors: OutlookFactors): number {
  const total = (
    Object.keys(OUTLOOK_WEIGHTS) as (keyof typeof OUTLOOK_WEIGHTS)[]
  ).reduce((sum, k) => sum + OUTLOOK_WEIGHTS[k] * clamp01(factors[k]), 0);
  return Math.round(total * 100 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------
@Injectable()
export class OutlookService {
  constructor(private readonly prisma: PrismaService) {}

  /** Latest persisted outlook for a (venue, night), or null if never computed. */
  async get(ctx: TenantContext, venueId: string, dateStr: string) {
    const { start } = dayRange(dateStr);
    const outlook = await this.prisma.eventOutlook.findFirst({
      where: { tenantId: ctx.tenantId, venueId, date: start },
    });
    return { tenantId: ctx.tenantId, venueId, date: dateStr, outlook };
  }

  /** Compute the v1 rules score for a (venue, night), upsert and return it. */
  async compute(ctx: TenantContext, venueId: string, dateStr: string) {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);
    const dow = start.getUTCDay();

    // Same-weekday baseline: historical bookings at this venue strictly before
    // the night, grouped per historical night, averaged.
    const historical = await this.prisma.booking.findMany({
      where: { tenantId: t, venueId, date: { lt: start } },
      select: { date: true, tab: { select: { total: true } } },
    });
    const byNight = new Map<string, { count: number; revenue: number }>();
    for (const b of historical) {
      if (b.date.getUTCDay() !== dow) continue;
      const key = b.date.toISOString().slice(0, 10);
      const cur = byNight.get(key) ?? { count: 0, revenue: 0 };
      cur.count += 1;
      cur.revenue += b.tab?.total ?? 0;
      byNight.set(key, cur);
    }
    const nights = [...byNight.values()];
    const baselineCount = nights.length
      ? nights.reduce((s, n) => s + n.count, 0) / nights.length
      : null;
    const baselineRevenue = nights.length
      ? nights.reduce((s, n) => s + n.revenue, 0) / nights.length
      : null;

    // Tonight's actionable bookings.
    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId,
        date: { gte: start, lt: end },
        status: { in: ['held', 'confirmed', 'seated'] },
      },
      select: {
        id: true,
        guestId: true,
        status: true,
        attributionId: true,
        inventoryId: true,
        inventory: { select: { minSpend: true } },
      },
    });
    const totalInventory = await this.prisma.inventory.count({
      where: { tenantId: t, venueId },
    });

    let payments: { status: string; amount: number }[] = [];
    let affinities: { score: number }[] = [];
    if (bookings.length > 0) {
      payments = await this.prisma.payment.findMany({
        where: { tenantId: t, bookingId: { in: bookings.map((b) => b.id) } },
        select: { status: true, amount: true },
      });
      const guestIds = [...new Set(bookings.map((b) => b.guestId))];
      affinities = await this.prisma.guestAffinity.findMany({
        where: { tenantId: t, guestId: { in: guestIds }, muted: false },
        select: { score: true },
      });
    }

    // Factors — 0–1 each, neutral 0.5 wherever the inputs don't exist yet.
    const projectedRevenue = bookings.reduce(
      (s, b) => s + (b.inventory?.minSpend ?? 0),
      0,
    );
    const bookedInventory = new Set(
      bookings.map((b) => b.inventoryId).filter(Boolean),
    ).size;
    const settledStatuses = ['succeeded', 'requires_capture'];

    const factors: OutlookFactors = {
      demandPace:
        baselineCount == null
          ? 0.5
          : ratioScore(bookings.length / Math.max(baselineCount, 1e-9)),
      revenueMargin:
        baselineRevenue == null || baselineRevenue === 0
          ? 0.5
          : ratioScore(projectedRevenue / baselineRevenue),
      inventoryYield:
        totalInventory === 0 ? 0.5 : clamp01(bookedInventory / totalInventory),
      audienceQuality:
        affinities.length === 0
          ? 0.5
          : clamp01(
              affinities.reduce((s, a) => s + a.score, 0) /
                affinities.length /
                5,
            ),
      paymentCertainty:
        payments.length === 0
          ? 0.5
          : clamp01(
              payments.filter((p) => settledStatuses.includes(p.status))
                .length / payments.length,
            ),
      marketingResponse:
        bookings.length === 0
          ? 0.5
          : clamp01(
              bookings.filter((b) => b.attributionId).length / bookings.length,
            ),
      opsReadiness:
        bookings.length === 0
          ? 0.5
          : clamp01(
              bookings.filter((b) => b.status !== 'held').length /
                bookings.length,
            ),
    };

    const score = computeOutlookScore(factors);
    const payload = {
      factors,
      inputs: {
        tonightBookings: bookings.length,
        baselineCount,
        baselineRevenueCents: baselineRevenue,
        projectedRevenueCents: projectedRevenue,
        bookedInventory,
        totalInventory,
        paymentsSeen: payments.length,
        affinitiesSeen: affinities.length,
      },
    };

    const outlook = await this.prisma.eventOutlook.upsert({
      where: {
        tenantId_venueId_date: { tenantId: t, venueId, date: start },
      },
      create: {
        tenantId: t,
        venueId,
        date: start,
        score,
        factors: payload,
        weightsVersion: OUTLOOK_WEIGHTS_VERSION,
      },
      update: {
        score,
        factors: payload,
        weightsVersion: OUTLOOK_WEIGHTS_VERSION,
        computedAt: new Date(),
      },
    });

    return {
      tenantId: t,
      venueId,
      date: dateStr,
      score,
      weightsVersion: OUTLOOK_WEIGHTS_VERSION,
      ...payload,
      outlookId: outlook.id,
    };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------
@ApiTags('ops:outlook')
@Controller('outlook')
export class OutlookController {
  constructor(private readonly svc: OutlookService) {}

  /** Latest persisted outlook for a venue+date (null if never computed). */
  @Get()
  @Scopes('ops:outlook:read')
  get(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.get(ctx, venueId, date);
  }

  /** Recompute + persist the v1 rules score for a venue+date. */
  @Post('compute')
  @Scopes('ops:outlook:write')
  compute(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.compute(ctx, venueId, date);
  }
}

@Module({
  controllers: [OutlookController],
  providers: [OutlookService],
  exports: [OutlookService],
})
export class OutlookModule {}
