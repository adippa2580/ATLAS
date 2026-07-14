import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsDateString, IsInt, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

// ---------------------------------------------------------------------------
// Talent / Programming insights (catalog insight I, with A + C + J context).
//
// Three read-side joins across the taste, money, and social pillars:
//   POST /talent/engagements  — record a booked artist (gives ROI its supply row)
//   GET  /talent/who-to-book  — latent demand for artists with NO engagement (A/I)
//   GET  /talent/roi          — per-engagement lift vs. same-weekday baseline (I/G)
//
// Money is integer cents throughout (mirrors Tab.total / TalentEngagement.cost).
// ---------------------------------------------------------------------------

class CreateEngagementDto {
  @IsString() venueId!: string;
  @IsString() entityId!: string; // Entity(kind=artist) — global catalog, no tenantId
  @IsDateString() date!: string;
  @IsOptional() @IsInt() cost?: number; // talent fee, minor units (cents)
  @IsOptional() @IsString() status?: string; // booked | confirmed | cancelled
}

/**
 * A UTC calendar-day [start, end) window for a given instant. Used to match a
 * `Booking.date` (a timestamp) to the calendar day of a `TalentEngagement.date`,
 * and to bucket bookings by weekday for the baseline.
 */
function dayRangeUtc(d: Date): { gte: Date; lt: Date } {
  const start = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()),
  );
  const end = new Date(start);
  end.setUTCDate(end.getUTCDate() + 1);
  return { gte: start, lt: end };
}

interface WhoToBookRow {
  subjectRef: string;
  demandScore: number;
  guestCount: number;
  crewReach: number;
  alreadyBooked: false;
}

interface RoiRow {
  engagementId: string;
  entityId: string;
  date: Date;
  nightRevenueCents: number;
  baselineCents: number;
  liftCents: number;
  costCents: number | null;
  roi: number | null;
}

@Injectable()
export class TalentService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Record a booked artist engagement (tenant-scoped). This is the supply side
   * that the ROI scorecard measures against and that who-to-book subtracts out.
   */
  async createEngagement(ctx: TenantContext, dto: CreateEngagementDto) {
    return this.prisma.talentEngagement.create({
      data: {
        tenantId: ctx.tenantId,
        venueId: dto.venueId,
        entityId: dto.entityId,
        date: new Date(dto.date),
        cost: dto.cost ?? null,
        status: dto.status ?? 'booked',
      },
    });
  }

  /**
   * Insight A / I — "who to book next". Rank `artist` subjects by latent local
   * demand (Σ GuestAffinity.score, muted=false) and distinct interested guests
   * for this tenant, then SUBTRACT any artist that already has a
   * TalentEngagement — surfacing demand that currently has no supply.
   *
   * `subjectRef` on an artist affinity is the artist's catalog Entity.id, which
   * is exactly what `TalentEngagement.entityId` references, so the anti-join is
   * a straight ref match.
   */
  async whoToBook(ctx: TenantContext, limit = 20): Promise<WhoToBookRow[]> {
    const t = ctx.tenantId;

    const [affinities, engagements, crewAffinities] = await Promise.all([
      this.prisma.guestAffinity.findMany({
        where: { tenantId: t, subjectType: 'artist', muted: false },
        select: { subjectRef: true, guestId: true, score: true },
      }),
      // Already-booked artists (any status) for this tenant — the supply set.
      this.prisma.talentEngagement.findMany({
        where: { tenantId: t },
        select: { entityId: true },
      }),
      // Nice-to-have "crew reach": crews that blend high on this artist.
      this.prisma.crewAffinity.findMany({
        where: { tenantId: t, subjectType: 'artist', blendedScore: { gte: 0.5 } },
        select: { subjectRef: true, crewId: true },
      }),
    ]);

    const booked = new Set(engagements.map((e) => e.entityId));

    const crewReach = new Map<string, Set<string>>();
    for (const c of crewAffinities) {
      if (!crewReach.has(c.subjectRef)) crewReach.set(c.subjectRef, new Set());
      crewReach.get(c.subjectRef)!.add(c.crewId);
    }

    // Aggregate demand per artist ref, counting distinct guests.
    const agg = new Map<
      string,
      { demandScore: number; guests: Set<string> }
    >();
    for (const a of affinities) {
      if (booked.has(a.subjectRef)) continue; // demand with no supply only
      let row = agg.get(a.subjectRef);
      if (!row) {
        row = { demandScore: 0, guests: new Set() };
        agg.set(a.subjectRef, row);
      }
      row.demandScore += a.score;
      row.guests.add(a.guestId);
    }

    return Array.from(agg.entries())
      .map(([subjectRef, v]) => ({
        subjectRef,
        demandScore: v.demandScore,
        guestCount: v.guests.size,
        crewReach: crewReach.get(subjectRef)?.size ?? 0,
        alreadyBooked: false as const,
      }))
      .sort((x, y) => y.demandScore - x.demandScore)
      .slice(0, limit);
  }

  /**
   * Insight I / G — talent ROI scorecard. For each engagement:
   *   nightRevenue = Σ Tab.total over bookings at that venue on that calendar day
   *   baseline     = avg nightly Tab.total for that venue on the SAME weekday,
   *                  across dates that had NO engagement (the counterfactual)
   *   liftCents    = nightRevenue − baseline
   *   roi          = cost ? liftCents / cost : null
   *
   * Join legs: TalentEngagement → (venueId, day) → Booking.venueId ⋈ Booking.tab
   * (Tab is 1:1 with Booking via bookingId). All revenue in integer cents.
   */
  async roi(ctx: TenantContext): Promise<RoiRow[]> {
    const t = ctx.tenantId;

    const engagements = await this.prisma.talentEngagement.findMany({
      where: { tenantId: t },
    });
    if (engagements.length === 0) return [];

    // Pull every booking (with its tab) for the venues under study, once.
    const venueIds = Array.from(new Set(engagements.map((e) => e.venueId)));
    const bookings = await this.prisma.booking.findMany({
      where: { tenantId: t, venueId: { in: venueIds } },
      select: {
        venueId: true,
        date: true,
        tab: { select: { total: true } },
      },
    });

    // Nights that are "engagement nights" per venue (excluded from baseline).
    // Key: `${venueId}|${YYYY-MM-DD}` in UTC.
    const dayKey = (venueId: string, d: Date) => {
      const r = dayRangeUtc(d);
      return `${venueId}|${r.gte.toISOString().slice(0, 10)}`;
    };
    const engagementNights = new Set(
      engagements.map((e) => dayKey(e.venueId, e.date)),
    );

    // Per-venue nightly revenue, bucketed by calendar day AND by weekday, so the
    // baseline is an average over *distinct non-engagement nights* (not tabs).
    // nightlyTotals: venueId -> dayKey -> summed Tab.total
    // weekdayNights: venueId -> weekday(0-6) -> dayKey -> summed Tab.total
    const nightlyTotals = new Map<string, Map<string, number>>();
    const weekdayNights = new Map<string, Map<number, Map<string, number>>>();

    for (const b of bookings) {
      const total = b.tab?.total ?? 0;
      const key = dayKey(b.venueId, b.date);
      const weekday = b.date.getUTCDay();

      const vNight = nightlyTotals.get(b.venueId) ?? new Map<string, number>();
      vNight.set(key, (vNight.get(key) ?? 0) + total);
      nightlyTotals.set(b.venueId, vNight);

      const vWeek =
        weekdayNights.get(b.venueId) ?? new Map<number, Map<string, number>>();
      const wd = vWeek.get(weekday) ?? new Map<string, number>();
      wd.set(key, (wd.get(key) ?? 0) + total);
      vWeek.set(weekday, wd);
      weekdayNights.set(b.venueId, vWeek);
    }

    const rows: RoiRow[] = engagements.map((e) => {
      const key = dayKey(e.venueId, e.date);
      const nightRevenueCents = nightlyTotals.get(e.venueId)?.get(key) ?? 0;
      const baselineCents = this.weekdayBaseline(
        weekdayNights,
        engagementNights,
        e.venueId,
        e.date,
      );
      const liftCents = nightRevenueCents - baselineCents;
      const costCents = e.cost ?? null;
      const roi = costCents ? liftCents / costCents : null;
      return {
        engagementId: e.id,
        entityId: e.entityId,
        date: e.date,
        nightRevenueCents,
        baselineCents,
        liftCents,
        costCents,
        roi,
      };
    });

    return rows.sort((a, b) => b.liftCents - a.liftCents);
  }

  /**
   * Baseline = average nightly revenue for `venueId` on the SAME UTC weekday as
   * `date`, averaged over distinct nights that were NOT engagement nights (the
   * counterfactual "normal night"). Returns 0 (integer cents) when there is no
   * comparable non-engagement night to learn from.
   */
  private weekdayBaseline(
    weekdayNights: Map<string, Map<number, Map<string, number>>>,
    engagementNights: Set<string>,
    venueId: string,
    date: Date,
  ): number {
    const weekday = date.getUTCDay();
    const nights = weekdayNights.get(venueId)?.get(weekday);
    if (!nights || nights.size === 0) return 0;

    let sum = 0;
    let count = 0;
    for (const [nightKey, total] of nights) {
      if (engagementNights.has(nightKey)) continue; // exclude engagement nights
      sum += total;
      count += 1;
    }
    if (count === 0) return 0;
    return Math.round(sum / count);
  }
}

@ApiTags('talent')
@Controller('talent')
export class TalentController {
  constructor(private readonly svc: TalentService) {}

  @Post('engagements')
  @Scopes('mkt:reporting:write')
  createEngagement(
    @Tenant() ctx: TenantContext,
    @Body() dto: CreateEngagementDto,
  ) {
    return this.svc.createEngagement(ctx, dto);
  }

  @Get('who-to-book')
  @Scopes('mkt:reporting:read')
  whoToBook(@Tenant() ctx: TenantContext, @Query('limit') limit?: string) {
    const n = limit ? Number(limit) : undefined;
    return this.svc.whoToBook(
      ctx,
      Number.isFinite(n as number) ? (n as number) : undefined,
    );
  }

  @Get('roi')
  @Scopes('mkt:reporting:read')
  roi(@Tenant() ctx: TenantContext) {
    return this.svc.roi(ctx);
  }
}

@Module({
  controllers: [TalentController],
  providers: [TalentService],
  exports: [TalentService],
})
export class TalentModule {}
