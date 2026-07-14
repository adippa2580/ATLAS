import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubjectType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/**
 * Cross-pillar "graph insights" — read-only joins across the taste graph, the
 * social (crew) graph, and the ops booking/POS ledger. Each endpoint realizes
 * one insight from docs/analytics/cross-pillar-insights.md:
 *   - GET /insights/demand       -> Insight A (affinity demand index)
 *   - GET /insights/connectors   -> Insight C (crew super-connectors)
 *   - GET /insights/portability  -> Insight J (cross-venue artist portability)
 * All queries are tenant-scoped. Entity is a global catalog (no tenantId);
 * Guest has no city (locality lives on Booking -> Venue.city).
 */
@Injectable()
export class GraphInsightsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Insight A — Affinity as a leading indicator of demand.
   * Rank artist/genre subjects by summed GuestAffinity.score (muted=false),
   * i.e. latent demand, grouped by (subjectType, subjectRef). Because
   * GuestAffinity is unique per (tenant, guest, subjectType, subjectRef), the
   * row count per group is the distinct-guest count. Realized booking activity
   * has no direct FK from Booking to a taste subject (Booking carries no
   * subjectRef/Entity link), so we surface the demand ranking and label it
   * latent — the "high-affinity, low-conversion" contrast is left to the
   * operator / a booking-side join (see note).
   */
  async demand(ctx: TenantContext, top = 20) {
    const groups = await this.prisma.guestAffinity.groupBy({
      by: ['subjectType', 'subjectRef'],
      where: {
        tenantId: ctx.tenantId,
        muted: false,
        subjectType: { in: [SubjectType.artist, SubjectType.genre] },
      },
      _sum: { score: true },
      _count: { guestId: true },
    });

    const ranked = groups
      .map((g) => ({
        subjectType: g.subjectType,
        subjectRef: g.subjectRef,
        demandScore: g._sum.score ?? 0,
        guestCount: g._count.guestId,
      }))
      .sort((a, b) => b.demandScore - a.demandScore)
      .slice(0, top);

    return {
      insight: 'A:affinity-demand-index',
      note:
        'demandScore is summed GuestAffinity.score (muted=false) per ' +
        '(subjectType, subjectRef) — latent demand upstream of any booking. ' +
        'Booking carries no taste-subject FK, so realized conversion is not ' +
        'joined here; treat every row as latent demand to be validated against ' +
        'the booking curve.',
      ranking: ranked,
    };
  }

  /**
   * Insight C — Crew super-connectors & crew-amplified draw.
   * Per Crew: distinct members reached (CrewMember rows), bookings anchored on
   * Booking.crewId, and group spend = Σ Tab.total on those crew bookings
   * (Booking.crewId -> Booking.tab). connectorScore = memberCount x crewBookings
   * (distinct members reached multiplied by the tables they actually assemble).
   */
  async connectors(ctx: TenantContext, top = 20) {
    const t = ctx.tenantId;
    const [crews, memberGroups, crewBookings] = await Promise.all([
      this.prisma.crew.findMany({
        where: { tenantId: t },
        select: { id: true, name: true },
      }),
      this.prisma.crewMember.groupBy({
        by: ['crewId'],
        where: { tenantId: t },
        _count: { guestId: true },
      }),
      this.prisma.booking.findMany({
        where: { tenantId: t, crewId: { not: null } },
        select: { crewId: true, tab: { select: { total: true } } },
      }),
    ]);

    const memberCountByCrew = new Map<string, number>();
    for (const m of memberGroups) {
      memberCountByCrew.set(m.crewId, m._count.guestId);
    }

    const bookingStats = new Map<string, { count: number; spend: number }>();
    for (const b of crewBookings) {
      if (!b.crewId) continue;
      const s = bookingStats.get(b.crewId) ?? { count: 0, spend: 0 };
      s.count += 1;
      s.spend += b.tab?.total ?? 0;
      bookingStats.set(b.crewId, s);
    }

    const ranked = crews
      .map((c) => {
        const memberCount = memberCountByCrew.get(c.id) ?? 0;
        const stats = bookingStats.get(c.id) ?? { count: 0, spend: 0 };
        return {
          crewId: c.id,
          name: c.name,
          memberCount,
          crewBookings: stats.count,
          groupSpend: stats.spend,
          connectorScore: memberCount * stats.count,
        };
      })
      .sort((a, b) => b.connectorScore - a.connectorScore)
      .slice(0, top);

    return { insight: 'C:crew-super-connectors', ranking: ranked };
  }

  /**
   * Insight J — Cross-venue / artist portability.
   * For a given artist subjectRef, compute per-Venue the latent following that
   * artist has among guests who have booked that venue:
   *   GuestAffinity(subjectRef=artist).guestId
   *     -> Booking.guestId -> Booking.venueId (distinct guest per venue)
   * summing each qualifying guest's affinity score once per venue. Shows an
   * operator where an artist's draw already travels inside the portfolio.
   */
  async portability(ctx: TenantContext, subjectRef?: string, top = 20) {
    if (!subjectRef) {
      throw new BadRequestException(
        'Query param `subjectRef` (artist) is required.',
      );
    }
    const t = ctx.tenantId;

    const affinities = await this.prisma.guestAffinity.findMany({
      where: {
        tenantId: t,
        muted: false,
        subjectType: SubjectType.artist,
        subjectRef,
      },
      select: { guestId: true, score: true },
    });

    const scoreByGuest = new Map<string, number>();
    for (const a of affinities) {
      // Unique on (tenant, guest, subjectType, subjectRef): one row per guest.
      scoreByGuest.set(a.guestId, a.score);
    }
    const guestIds = [...scoreByGuest.keys()];

    const [venues, bookings] = await Promise.all([
      this.prisma.venue.findMany({
        where: { tenantId: t },
        select: { id: true, name: true },
      }),
      guestIds.length
        ? this.prisma.booking.findMany({
            where: { tenantId: t, guestId: { in: guestIds } },
            select: { guestId: true, venueId: true },
          })
        : Promise.resolve(
            [] as { guestId: string; venueId: string }[],
          ),
    ]);

    // Dedupe guest<->venue pairs so a guest counts once per venue it booked.
    const seen = new Set<string>();
    const perVenue = new Map<string, { demand: number; guests: number }>();
    for (const b of bookings) {
      const pairKey = `${b.venueId}:${b.guestId}`;
      if (seen.has(pairKey)) continue;
      seen.add(pairKey);
      const score = scoreByGuest.get(b.guestId) ?? 0;
      const agg = perVenue.get(b.venueId) ?? { demand: 0, guests: 0 };
      agg.demand += score;
      agg.guests += 1;
      perVenue.set(b.venueId, agg);
    }

    const nameById = new Map(venues.map((v) => [v.id, v.name]));
    const ranking = [...perVenue.entries()]
      .map(([venueId, agg]) => ({
        venueId,
        venueName: nameById.get(venueId) ?? null,
        latentDemand: agg.demand,
        guestCount: agg.guests,
      }))
      .sort((a, b) => b.latentDemand - a.latentDemand)
      .slice(0, top);

    return {
      insight: 'J:cross-venue-portability',
      subjectRef,
      ranking,
    };
  }
}

@ApiTags('insights')
@Controller('insights')
export class GraphInsightsController {
  constructor(private readonly svc: GraphInsightsService) {}

  @Get('demand')
  @Scopes('mkt:reporting:read')
  demand(@Tenant() ctx: TenantContext) {
    return this.svc.demand(ctx);
  }

  @Get('connectors')
  @Scopes('mkt:reporting:read')
  connectors(@Tenant() ctx: TenantContext) {
    return this.svc.connectors(ctx);
  }

  @Get('portability')
  @Scopes('mkt:reporting:read')
  portability(
    @Tenant() ctx: TenantContext,
    @Query('subjectRef') subjectRef?: string,
  ) {
    return this.svc.portability(ctx, subjectRef);
  }
}

@Module({
  controllers: [GraphInsightsController],
  providers: [GraphInsightsService],
  exports: [GraphInsightsService],
})
export class GraphInsightsModule {}
