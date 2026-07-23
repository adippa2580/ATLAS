import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubjectType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import {
  EventsFeedAdapter,
  FeedEvent,
} from '../../integrations/eventsfeed.adapter';

/**
 * "Concerts" (Team INS-CONCERTS) — the "artists your guests follow are playing
 * near this venue" join:
 *   GET /insights/concerts  — upcoming shows for the artists a venue's recent,
 *                             consented room has taste affinities for.
 *
 * Concerts have NO music-platform API of their own, so we join our OWN taste
 * graph (GuestAffinity, SubjectType.artist) to the public events feed
 * (Ticketmaster Discovery, via EventsFeedAdapter.eventsByArtist). The taste
 * side is always tenant-scoped + consent-gated; the feed side is class-3
 * entity/catalog data (no guest records leave the building).
 *
 * Read-only + tenant-scoped; no money is involved anywhere here. Resilient by
 * design: eventsByArtist returns [] on a miss or a hiccup, so a feed outage
 * degrades to an empty concert slate rather than a 500.
 */

// ---------------------------------------------------------------------------
// Tunables (kept in-file, mirroring the ops-insights / blend house style)
// ---------------------------------------------------------------------------

/** Cap on how many top artists we fan out to the external feed per request. */
const MAX_ARTISTS = 12;
/** Bounded fan-out: how many eventsByArtist calls are in flight at once. */
const FEED_CONCURRENCY = 4;
/** Events requested per artist from the feed. */
const EVENTS_PER_ARTIST = 3;
/** Concerts returned to the caller after the date sort. */
const MAX_CONCERTS = 20;

/** One aggregated artist the cohort has affinities for, before the feed join. */
type ArtistDemand = {
  artist: string;
  guestsInterested: number;
  sumScore: number;
};

/**
 * Run `worker` over `items` with at most `limit` in flight at once (batches of
 * `limit` via Promise.all) — not all at once, not fully sequential.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const settled = await Promise.all(batch.map(worker));
    out.push(...settled);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ConcertsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: EventsFeedAdapter,
  ) {}

  /**
   * Concerts the venue's recent, consented room would care about. Cohort =
   * distinct guests with a non-cancelled booking at the venue in the last
   * `days`, whose identity is enriched (provisional:false) and who carry a live
   * marketing/identity consent. We aggregate that cohort's artist affinities,
   * take the top `MAX_ARTISTS`, and fan out (bounded) to the events feed.
   */
  async concerts(ctx: TenantContext, venueId?: string, days = 30) {
    const t = ctx.tenantId;
    const windowDays = Number.isFinite(days) && days > 0 ? days : 30;

    // 1. Resolve the venue (given id, else the tenant's first venue).
    const venue = venueId
      ? await this.prisma.venue.findFirst({
          where: { id: venueId, tenantId: t },
          select: { id: true, city: true },
        })
      : await this.prisma.venue.findFirst({
          where: { tenantId: t },
          orderBy: { createdAt: 'asc' },
          select: { id: true, city: true },
        });

    if (!venue) {
      return {
        venueId: null,
        city: null,
        artistsConsidered: 0,
        concerts: [] as ConcertRow[],
        scanned: 0,
      };
    }
    const venueCity = venue.city ?? undefined;

    // 2. Cohort: non-cancelled bookings at the venue in the window, then the
    //    consent + provisional gate pushed into the guest query.
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const recent = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId: venue.id,
        status: { not: 'cancelled' },
        date: { gte: since },
      },
      select: { guestId: true },
    });
    const cohortIds = [...new Set(recent.map((b) => b.guestId))];

    const consented = cohortIds.length
      ? await this.prisma.guest.findMany({
          where: {
            tenantId: t,
            id: { in: cohortIds },
            provisional: false,
            consents: {
              some: {
                revokedAt: null,
                scope: { in: ['marketing', 'identity'] },
              },
            },
          },
          select: { id: true },
        })
      : [];
    const consentedIds = consented.map((g) => g.id);

    if (consentedIds.length === 0) {
      return {
        venueId: venue.id,
        city: venue.city ?? null,
        artistsConsidered: 0,
        concerts: [] as ConcertRow[],
        scanned: 0,
      };
    }

    // 3. Their artist affinities, aggregated per artist (subjectRef).
    const affinities = await this.prisma.guestAffinity.findMany({
      where: {
        tenantId: t,
        guestId: { in: consentedIds },
        subjectType: SubjectType.artist,
        muted: false,
      },
      select: { guestId: true, subjectRef: true, score: true },
    });

    const acc = new Map<
      string,
      { artist: string; sumScore: number; guests: Set<string> }
    >();
    for (const a of affinities) {
      const cur = acc.get(a.subjectRef) ?? {
        artist: a.subjectRef,
        sumScore: 0,
        guests: new Set<string>(),
      };
      cur.sumScore += a.score;
      cur.guests.add(a.guestId);
      acc.set(a.subjectRef, cur);
    }

    const demand: ArtistDemand[] = Array.from(acc.values())
      .map((a) => ({
        artist: a.artist,
        guestsInterested: a.guests.size,
        sumScore: a.sumScore,
      }))
      .sort(
        (x, y) =>
          y.guestsInterested - x.guestsInterested || y.sumScore - x.sumScore,
      )
      .slice(0, MAX_ARTISTS);

    const scanned = demand.length;

    // 4. Fan out to the feed with bounded concurrency; never let a hiccup throw
    //    (eventsByArtist already returns [] on failure, but stay defensive).
    const perArtist = await mapConcurrent(
      demand,
      FEED_CONCURRENCY,
      async (d) => {
        let events: FeedEvent[] = [];
        try {
          events = await this.feed.eventsByArtist(d.artist, {
            city: venueCity,
            size: EVENTS_PER_ARTIST,
          });
        } catch {
          events = [];
        }
        return { demand: d, events };
      },
    );

    // 5. Flatten to concert rows; artistsConsidered = artists with ≥1 event.
    const concerts: ConcertRow[] = [];
    let artistsConsidered = 0;
    for (const { demand: d, events } of perArtist) {
      if (events.length > 0) artistsConsidered += 1;
      for (const event of events) {
        concerts.push({
          artist: d.artist,
          guestsInterested: d.guestsInterested,
          event: event.name,
          date: event.date,
          venue: event.venueName ?? null,
          city: event.city,
        });
      }
    }

    // 6. Sort by date ascending; return the soonest MAX_CONCERTS.
    concerts.sort((a, b) => a.date.localeCompare(b.date));

    return {
      venueId: venue.id,
      city: venue.city ?? null,
      artistsConsidered,
      concerts: concerts.slice(0, MAX_CONCERTS),
      scanned,
    };
  }
}

/** One concert row in the response. */
type ConcertRow = {
  artist: string;
  guestsInterested: number;
  event: string;
  date: string; // ISO
  venue: string | null;
  city: string;
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('insights')
@Controller('insights')
export class ConcertsController {
  constructor(private readonly svc: ConcertsService) {}

  /**
   * Concerts — upcoming shows for the artists a venue's recent, consented room
   * has taste affinities for. Optional `venueId` (defaults to the tenant's
   * first venue) and `days` window (default 30).
   */
  @Get('concerts')
  @Scopes('mkt:reporting:read')
  concerts(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId?: string,
    @Query('days') days?: string,
  ) {
    return this.svc.concerts(
      ctx,
      venueId,
      days === undefined ? undefined : Number(days),
    );
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@Module({
  controllers: [ConcertsController],
  providers: [ConcertsService],
  exports: [ConcertsService],
})
export class ConcertsModule {}
