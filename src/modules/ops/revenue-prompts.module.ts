import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { categorizeSku } from '../../insights/ops/ops-insights.module';

/**
 * Revenue prompts (Team OPS) — two read-only, tenant-scoped revenue levers that
 * sit on top of the ops + taste pillars. Money is always integer minor units
 * (cents), matching Tab.total / Tab.lineItems[].amount / Inventory.minSpend.
 *
 *   1. GET /revenue/midweek-menu   — "Launch midweek taste-matched menus":
 *      for a soft midweek (Tue–Thu) night, rank product categories by the
 *      venue's historical line-item spend crossed with the product/genre
 *      affinities of the guests actually booked that night.
 *   2. GET /revenue/attach-prompts — "Scale bottle-service attach prompts":
 *      from historical tabs, learn the attach rate + average incremental spend
 *      of bottle-service / high-margin categories, then emit a per-booking
 *      prompt for tonight, prioritising guests whose spend affinity matches.
 *
 * Both mirror the line-item reading + `categorizeSku` bucketing from
 * OpsInsights.productMix(), so the taxonomy stays consistent across surfaces.
 */

// ---------------------------------------------------------------------------
// Pure helpers (kept in-file, hand-tested — mirror ops-insights internals)
// ---------------------------------------------------------------------------

type LineItem = { name: string; amount: number };

/** UTC [start, end) day window for a YYYY-MM-DD string (mirrors ops-insights). */
function dayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/** True for a soft midweek night: Tue (2), Wed (3), Thu (4) in UTC. */
function isMidweek(start: Date): boolean {
  const dow = start.getUTCDay();
  return dow >= 2 && dow <= 4;
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

/**
 * Bottle-service / high-margin categories. These are the buckets the attach
 * lever prompts on — the room's premium liquor that carries the margin.
 */
const BOTTLE_SERVICE_CATEGORIES = ['champagne', 'tequila', 'spirit'] as const;

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export interface MidweekSuggestion {
  category: string;
  rationale: string;
  affinityWeight: number; // Σ GuestAffinity.score for product/genre refs → this category
  historicalSpendCents: number; // Σ Tab line-item spend historically in this category
  combinedScore: number; // normalised (spendShare + affinityShare), the rank key
}

export interface AttachSuggestion {
  category: string;
  avgUpliftCents: number; // avg incremental spend when this category attaches
  attachRate: number; // share of historical tabs that carried this category
  matched: boolean; // does this booking's guest have a matching spend affinity?
}

export interface AttachPrompt {
  bookingId: string;
  guestId: string;
  priorityScore: number; // Σ matching affinity score — drives ordering
  suggestedAttach: AttachSuggestion[];
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class RevenuePromptsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lever 1 — "Launch midweek taste-matched menus". Aggregates the venue's
   * historical Tab line-item spend by product category, cross-references the
   * top product/genre affinities of the guests booked that night, and returns
   * categories ranked by a combined (spend + affinity) score.
   */
  async midweekMenu(ctx: TenantContext, venueId: string, dateStr: string) {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);

    // Historical line-item spend by category (all of the venue's tabs strictly
    // before the requested night). Mirrors productMix()'s read + bucketing.
    const historical = await this.prisma.booking.findMany({
      where: { tenantId: t, venueId, date: { lt: start } },
      select: { tab: { select: { lineItems: true } } },
    });

    const spendByCat = new Map<string, number>();
    for (const b of historical) {
      const items = readLineItems(b.tab?.lineItems as unknown);
      for (const li of items) {
        const cat = categorizeSku(li.name);
        spendByCat.set(cat, (spendByCat.get(cat) ?? 0) + li.amount);
      }
    }

    // Tonight's booked guests → their product/genre spend affinities.
    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId,
        date: { gte: start, lt: end },
        status: { in: ['held', 'confirmed', 'seated'] },
      },
      select: { guestId: true },
    });
    const guestIds = [...new Set(bookings.map((b) => b.guestId))];

    const affinities = guestIds.length
      ? await this.prisma.guestAffinity.findMany({
          where: {
            tenantId: t,
            guestId: { in: guestIds },
            subjectType: { in: ['product', 'genre'] },
            muted: false,
          },
          select: { subjectRef: true, score: true },
        })
      : [];

    // Fold each affinity ref into the same category taxonomy as the spend.
    const affinityByCat = new Map<string, number>();
    for (const a of affinities) {
      const cat = categorizeSku(a.subjectRef);
      affinityByCat.set(cat, (affinityByCat.get(cat) ?? 0) + a.score);
    }

    const categories = new Set<string>([
      ...spendByCat.keys(),
      ...affinityByCat.keys(),
    ]);
    const maxSpend = Math.max(1, ...[...spendByCat.values()], 0);
    const maxAff = Math.max(1, ...[...affinityByCat.values()], 0);

    const suggestions: MidweekSuggestion[] = [...categories].map((category) => {
      const historicalSpendCents = spendByCat.get(category) ?? 0;
      const affinityWeight =
        Math.round((affinityByCat.get(category) ?? 0) * 100) / 100;
      const spendShare = historicalSpendCents / maxSpend;
      const affinityShare = affinityWeight / maxAff;
      const combinedScore =
        Math.round((spendShare + affinityShare) * 10000) / 10000;

      let rationale: string;
      if (affinityWeight > 0 && historicalSpendCents > 0) {
        rationale = `Strong ${category} affinity (weight ${affinityWeight}) among tonight's guests meets ${historicalSpendCents} cents of historical ${category} spend`;
      } else if (affinityWeight > 0) {
        rationale = `Tonight's guests skew ${category} (affinity weight ${affinityWeight}) — a fresh taste-match with no historical baseline`;
      } else {
        rationale = `Dependable ${category} category historically (${historicalSpendCents} cents); no direct affinity among tonight's guests`;
      }

      return {
        category,
        rationale,
        affinityWeight,
        historicalSpendCents,
        combinedScore,
      };
    });

    // Rank by combined spend + affinity, then by raw historical spend.
    suggestions.sort(
      (a, b) =>
        b.combinedScore - a.combinedScore ||
        b.historicalSpendCents - a.historicalSpendCents,
    );

    const midweek = isMidweek(start);
    return {
      tenantId: t,
      venueId,
      date: dateStr,
      midweek,
      framing: midweek ? 'soft-midweek' : 'off-midweek',
      note: midweek
        ? 'Soft midweek (Tue–Thu): lead with taste-matched picks to lift a quieter night.'
        : 'Not a midweek night — ranking still reflects taste-matched category demand.',
      guestCount: guestIds.length,
      suggestions,
    };
  }

  /**
   * Lever 2 — "Scale bottle-service attach prompts". Learns per-category attach
   * rate + average incremental spend from the venue's historical tabs, then
   * emits a per-booking prompt for the night, prioritising guests whose product
   * spend affinity matches a bottle-service category.
   */
  async attachPrompts(ctx: TenantContext, venueId: string, dateStr: string) {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);

    // Historical tabs at the venue (strictly before the night).
    const historical = await this.prisma.booking.findMany({
      where: { tenantId: t, venueId, date: { lt: start } },
      select: { tab: { select: { lineItems: true } } },
    });

    // Per bottle-service category: how many tabs carried it, and the total
    // incremental spend it contributed (summed per-tab, then averaged).
    let totalTabs = 0;
    const tabsWithCat = new Map<string, number>();
    const upliftSumByCat = new Map<string, number>();
    for (const b of historical) {
      if (!b.tab) continue;
      const items = readLineItems(b.tab.lineItems as unknown);
      if (items.length === 0) continue;
      totalTabs += 1;
      const catSpend = new Map<string, number>();
      for (const li of items) {
        const cat = categorizeSku(li.name);
        catSpend.set(cat, (catSpend.get(cat) ?? 0) + li.amount);
      }
      for (const cat of BOTTLE_SERVICE_CATEGORIES) {
        const spent = catSpend.get(cat);
        if (spent && spent > 0) {
          tabsWithCat.set(cat, (tabsWithCat.get(cat) ?? 0) + 1);
          upliftSumByCat.set(cat, (upliftSumByCat.get(cat) ?? 0) + spent);
        }
      }
    }

    const categoryStats = BOTTLE_SERVICE_CATEGORIES.map((category) => {
      const count = tabsWithCat.get(category) ?? 0;
      const attachRate =
        totalTabs > 0 ? Math.round((count / totalTabs) * 100) / 100 : 0;
      const avgUpliftCents =
        count > 0 ? Math.round((upliftSumByCat.get(category) ?? 0) / count) : 0;
      return { category, attachRate, avgUpliftCents, tabsWithCategory: count };
    }).filter((s) => s.avgUpliftCents > 0);

    const statByCat = new Map<string, (typeof categoryStats)[number]>(
      categoryStats.map((s) => [s.category as string, s]),
    );

    // Tonight's actionable bookings + each guest's matching spend affinities.
    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId,
        date: { gte: start, lt: end },
        status: { in: ['held', 'confirmed', 'seated'] },
      },
      select: { id: true, guestId: true },
    });
    const guestIds = [...new Set(bookings.map((b) => b.guestId))];

    const affinities = guestIds.length
      ? await this.prisma.guestAffinity.findMany({
          where: {
            tenantId: t,
            guestId: { in: guestIds },
            subjectType: { in: ['product', 'genre'] },
            muted: false,
          },
          select: { guestId: true, subjectRef: true, score: true },
        })
      : [];

    // Per guest: score per bottle-service category they have an affinity for.
    const affScoreByGuestCat = new Map<string, Map<string, number>>();
    for (const a of affinities) {
      const cat = categorizeSku(a.subjectRef);
      if (!statByCat.has(cat)) continue; // only categories we actually prompt on
      const g = affScoreByGuestCat.get(a.guestId) ?? new Map<string, number>();
      g.set(cat, (g.get(cat) ?? 0) + a.score);
      affScoreByGuestCat.set(a.guestId, g);
    }

    const prompts: AttachPrompt[] = bookings.map((b) => {
      const matched = affScoreByGuestCat.get(b.guestId) ?? new Map();
      const priorityScore =
        Math.round(
          [...matched.values()].reduce((s: number, v: number) => s + v, 0) *
            100,
        ) / 100;

      const suggestedAttach: AttachSuggestion[] = categoryStats
        .map((s) => ({
          category: s.category,
          avgUpliftCents: s.avgUpliftCents,
          attachRate: s.attachRate,
          matched: matched.has(s.category),
        }))
        // Affinity-matched categories surface first, then by average uplift.
        .sort(
          (x, y) =>
            Number(y.matched) - Number(x.matched) ||
            y.avgUpliftCents - x.avgUpliftCents,
        );

      return {
        bookingId: b.id,
        guestId: b.guestId,
        priorityScore,
        suggestedAttach,
      };
    });

    // Prioritise bookings whose guest carries a matching spend affinity.
    prompts.sort(
      (a, b) =>
        b.priorityScore - a.priorityScore ||
        a.bookingId.localeCompare(b.bookingId),
    );

    return {
      tenantId: t,
      venueId,
      date: dateStr,
      historicalTabs: totalTabs,
      categoryStats,
      prompts,
    };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('ops:revenue')
@Controller('revenue')
export class RevenuePromptsController {
  constructor(private readonly svc: RevenuePromptsService) {}

  /** Lever 1 — midweek taste-matched menu picks for a venue+date. */
  @Get('midweek-menu')
  @Scopes('mkt:reporting:read')
  midweekMenu(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.midweekMenu(ctx, venueId, date);
  }

  /** Lever 2 — per-booking bottle-service attach prompts for a venue+date. */
  @Get('attach-prompts')
  @Scopes('mkt:reporting:read')
  attachPrompts(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.attachPrompts(ctx, venueId, date);
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@Module({
  controllers: [RevenuePromptsController],
  providers: [RevenuePromptsService],
  exports: [RevenuePromptsService],
})
export class RevenuePromptsModule {}
