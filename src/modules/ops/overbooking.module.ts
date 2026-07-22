import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import {
  NoShowFeatures,
  riskScore,
} from '../../insights/ops/ops-insights.module';

/**
 * Loosen overbooking guardrails (#Ops-yield) — a read-only planning surface that
 * recovers the empty seats hard capacity caps leave behind.
 *
 * Every held/confirmed booking carries a no-show probability. Summed across a
 * table's bookings that yields an expected number of seats that will go unused
 * tonight. Rather than let those seats sit dark, we recommend a small,
 * risk-proportional overbooking allowance per table: hold a few extra bookings
 * so the *expected* attended party still fits the real capacity.
 *
 * The allowance reuses the grounded no-show risk model from Insight D
 * (`riskScore` / `NoShowFeatures`), so the recommendation moves with the same
 * signals the deposit engine already trusts — trust history, prior cancels,
 * lead time, deposit, party size and identity.
 *
 * Guardrails on the guardrail-loosening: the recommendation is capped so the
 * new effective capacity never exceeds `capacity + ceil(expectedNoShows)` and
 * never adds more than +2 seats to any single table. Nothing here mutates
 * inventory — it is a recommendation the floor manager applies deliberately.
 */

const MAX_EXTRA_PER_TABLE = 2;

/** UTC [start, end) day window for a YYYY-MM-DD string. */
function dayRange(dateStr: string): { start: Date; end: Date } {
  const start = new Date(`${dateStr}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

/**
 * A single TrustEvent's signed contribution: a no_show erodes trust (negative),
 * everything else builds it (positive). Matches Insight D's feature extraction.
 */
function signedTrustWeight(kind: string, weight: number): number {
  return kind === 'no_show' ? -Math.abs(weight) : Math.abs(weight);
}

/** Per-table overbooking recommendation. */
export interface OverbookTable {
  inventoryId: string;
  label: string | null;
  capacity: number;
  bookedCount: number;
  expectedNoShows: number;
  recommendedOverbook: number;
  newEffectiveCapacity: number;
}

export interface OverbookPolicy {
  tenantId: string;
  venueId: string;
  date: string;
  tables: OverbookTable[];
  totalRecoverableSeats: number;
}

@Injectable()
export class OverbookingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Recommend a risk-based overbooking allowance per table for a venue+date.
   * Every read is tenant-scoped by `ctx.tenantId`.
   */
  async policy(
    ctx: TenantContext,
    venueId: string,
    dateStr: string,
  ): Promise<OverbookPolicy> {
    const t = ctx.tenantId;
    const { start, end } = dayRange(dateStr);

    const [tables, bookings] = await Promise.all([
      this.prisma.inventory.findMany({
        where: { tenantId: t, venueId, kind: 'table' },
        select: { id: true, label: true, capacity: true, deposit: true },
      }),
      this.prisma.booking.findMany({
        where: {
          tenantId: t,
          venueId,
          date: { gte: start, lt: end },
          status: { in: ['held', 'confirmed'] },
          inventoryId: { not: null },
        },
        include: {
          guest: { select: { provisional: true } },
          inventory: { select: { deposit: true } },
        },
      }),
    ]);

    const guestIds = [...new Set(bookings.map((b) => b.guestId))];

    // Per-guest trust net (signed) and prior-cancelled counts — identical
    // features to Insight D's noShowRisk().
    const [trustEvents, cancelledGroups] = await Promise.all([
      guestIds.length
        ? this.prisma.trustEvent.findMany({
            where: { tenantId: t, guestId: { in: guestIds } },
            select: { guestId: true, kind: true, weight: true },
          })
        : Promise.resolve(
            [] as { guestId: string; kind: string; weight: number }[],
          ),
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

    // Accumulate expected no-shows per inventory from each booking's risk.
    const byInventory = new Map<
      string,
      { bookedCount: number; expectedNoShows: number }
    >();
    for (const b of bookings) {
      if (!b.inventoryId) continue;
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
      // Convert the 0..100 risk score into an expected-no-show probability.
      const prob = riskScore(features) / 100;
      const cur = byInventory.get(b.inventoryId) ?? {
        bookedCount: 0,
        expectedNoShows: 0,
      };
      cur.bookedCount += 1;
      cur.expectedNoShows += prob;
      byInventory.set(b.inventoryId, cur);
    }

    const rows: OverbookTable[] = tables.map((inv) => {
      const agg = byInventory.get(inv.id) ?? {
        bookedCount: 0,
        expectedNoShows: 0,
      };
      const capacity = inv.capacity ?? 1;
      // Recommend rounding the expected no-shows into extra holds, but never let
      // the new effective capacity exceed capacity + ceil(expectedNoShows) and
      // never add more than +2 per table.
      const recommendedOverbook = Math.max(
        0,
        Math.min(
          MAX_EXTRA_PER_TABLE,
          Math.round(agg.expectedNoShows),
          Math.ceil(agg.expectedNoShows),
        ),
      );
      return {
        inventoryId: inv.id,
        label: inv.label ?? null,
        capacity,
        bookedCount: agg.bookedCount,
        expectedNoShows: Math.round(agg.expectedNoShows * 100) / 100,
        recommendedOverbook,
        newEffectiveCapacity: capacity + recommendedOverbook,
      };
    });

    const totalRecoverableSeats = rows.reduce(
      (acc, r) => acc + r.recommendedOverbook,
      0,
    );

    return {
      tenantId: t,
      venueId,
      date: dateStr,
      tables: rows,
      totalRecoverableSeats,
    };
  }
}

@ApiTags('ops:overbooking')
@Controller('v1/ops/overbooking')
export class OverbookingController {
  constructor(private readonly svc: OverbookingService) {}

  /**
   * Recommended risk-based overbooking allowance per table for a venue+date.
   */
  @Get('policy')
  @Scopes('ops:bookings:read')
  policy(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId: string,
    @Query('date') date: string,
  ) {
    return this.svc.policy(ctx, venueId, date);
  }
}

@Module({
  controllers: [OverbookingController],
  providers: [OverbookingService],
  exports: [OverbookingService],
})
export class OverbookingModule {}
