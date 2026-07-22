import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EntityKind, SubjectType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

/**
 * How many guests to surface per event in `topGuests`.
 */
export const TOP_GUESTS_PER_EVENT = 5;

/**
 * Suggested send window, expressed as lead time BEFORE the event date. The
 * win-back / offer should land while the event is close enough to feel like a
 * local tailwind but with enough runway for the guest to plan/book: open the
 * window LEAD_MAX_DAYS out, close it LEAD_MIN_DAYS out.
 */
export const LEAD_MAX_DAYS = 14;
export const LEAD_MIN_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Entity has no first-class date column (id, kind, name, externalRefs, metadata,
 * createdAt only), so an event's date — if any — lives in its free-form
 * `metadata` JSON. We read it best-effort from these keys, first hit wins.
 */
const EVENT_DATE_KEYS = [
  'date',
  'startsAt',
  'startDate',
  'eventDate',
  'starts_at',
];

/**
 * Metadata keys that may carry the event's artist lineup (Entity ids of
 * kind=artist). An 'artist' affinity whose subjectRef is in this lineup aligns a
 * guest to the event, alongside a direct 'event' affinity on the event id.
 */
const LINEUP_KEYS = ['artistIds', 'lineup', 'artists', 'lineupArtistIds'];

type SendWindow =
  | { start: string; end: string; basis: 'event-date' }
  | { start: null; end: null; basis: 'undated' };

interface TopGuest {
  guestId: string;
  displayName: string | null;
  affinityScore: number;
}

interface EventOpportunity {
  eventId: string;
  eventName: string;
  eventDate: string | null;
  matchedGuests: number;
  topGuests: TopGuest[];
  suggestedSendWindow: SendWindow;
}

function readMetadata(metadata: unknown): Record<string, unknown> {
  return metadata && typeof metadata === 'object' && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : {};
}

/** Best-effort parse of an event date from metadata. Returns null if absent/invalid. */
function parseEventDate(metadata: unknown): Date | null {
  const meta = readMetadata(metadata);
  for (const key of EVENT_DATE_KEYS) {
    const raw = meta[key];
    if (typeof raw === 'string' || typeof raw === 'number') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return null;
}

/** Best-effort parse of the artist-lineup Entity ids from metadata. */
function parseLineup(metadata: unknown): string[] {
  const meta = readMetadata(metadata);
  for (const key of LINEUP_KEYS) {
    const raw = meta[key];
    if (Array.isArray(raw)) {
      return raw.filter((x): x is string => typeof x === 'string');
    }
  }
  return [];
}

function sendWindowFor(eventDate: Date | null): SendWindow {
  if (!eventDate) return { start: null, end: null, basis: 'undated' };
  return {
    start: new Date(eventDate.getTime() - LEAD_MAX_DAYS * DAY_MS).toISOString(),
    end: new Date(eventDate.getTime() - LEAD_MIN_DAYS * DAY_MS).toISOString(),
    basis: 'event-date',
  };
}

/**
 * "Time offers to arena shows" — a PLANNING/analysis endpoint (no sends) that
 * rides local-events tailwinds. It reads the global Entity catalog for upcoming
 * events, matches each to the tenant's guests via their (tenant-scoped)
 * GuestAffinity on the event itself ('event') or on any artist in the event's
 * lineup ('artist'), and returns a ranked schedule of offer opportunities so the
 * operator knows WHO to win back and WHEN to send. Dispatch is left to the
 * existing win-back trigger.
 */
@Injectable()
export class EventOffersService {
  constructor(private readonly prisma: PrismaService) {}

  async eventTimedOffers(ctx: TenantContext, withinDays?: number) {
    const now = Date.now();
    const horizon =
      withinDays !== undefined && Number.isFinite(withinDays) && withinDays > 0
        ? now + withinDays * DAY_MS
        : undefined;

    // Entity is a GLOBAL catalog (no tenantId) — events are shared like artists.
    const events = await this.prisma.entity.findMany({
      where: { kind: EntityKind.event },
    });

    // Decorate each event with its parsed date + lineup, then apply the
    // "upcoming" filter. Entity has no date column, so an undated event is
    // always a candidate (noted in the response); a dated event is dropped only
    // when it is in the past or beyond the requested horizon.
    const candidates = events
      .map((e) => ({
        id: e.id,
        name: e.name,
        date: parseEventDate(e.metadata),
        lineup: parseLineup(e.metadata),
      }))
      .filter((e) => {
        if (!e.date) return true; // undated → always a candidate
        const t = e.date.getTime();
        if (t < now) return false; // already happened
        if (horizon !== undefined && t > horizon) return false;
        return true;
      });

    const datedCount = candidates.filter((e) => e.date).length;

    // Collect every affinity subjectRef that aligns a guest to ANY candidate:
    // the event ids themselves (event affinities) + all lineup artist ids
    // (artist affinities). One batched, tenant-scoped read covers all events.
    const eventIds = new Set(candidates.map((e) => e.id));
    const artistRefs = new Set<string>();
    for (const e of candidates) for (const a of e.lineup) artistRefs.add(a);

    const allRefs = [...new Set([...eventIds, ...artistRefs])];
    const affinities = allRefs.length
      ? await this.prisma.guestAffinity.findMany({
          where: {
            tenantId: ctx.tenantId,
            muted: false,
            subjectType: { in: [SubjectType.artist, SubjectType.event] },
            subjectRef: { in: allRefs },
          },
          select: {
            guestId: true,
            subjectType: true,
            subjectRef: true,
            score: true,
          },
        })
      : [];

    // Index affinities by the ref they carry so each event can pull its aligned
    // guests without rescanning: eventRef → guest event-affinities,
    // artistRef → guest artist-affinities.
    const byRef = new Map<string, { guestId: string; score: number }[]>();
    for (const a of affinities) {
      const list = byRef.get(a.subjectRef) ?? [];
      list.push({ guestId: a.guestId, score: a.score });
      byRef.set(a.subjectRef, list);
    }

    // Per event, sum a guest's aligned scores (a guest matching both the event
    // and a lineup artist counts once, scores combined).
    const perEvent = candidates.map((e) => {
      const scoreByGuest = new Map<string, number>();
      const refs = [e.id, ...e.lineup];
      for (const ref of refs) {
        for (const hit of byRef.get(ref) ?? []) {
          scoreByGuest.set(
            hit.guestId,
            (scoreByGuest.get(hit.guestId) ?? 0) + hit.score,
          );
        }
      }
      return { event: e, scoreByGuest };
    });

    // Resolve display names for the guests we will actually surface, tenant-scoped.
    const neededGuestIds = new Set<string>();
    for (const p of perEvent) {
      for (const gid of p.scoreByGuest.keys()) neededGuestIds.add(gid);
    }
    const guests = neededGuestIds.size
      ? await this.prisma.guest.findMany({
          where: { tenantId: ctx.tenantId, id: { in: [...neededGuestIds] } },
          select: { id: true, displayName: true },
        })
      : [];
    const nameById = new Map(guests.map((g) => [g.id, g.displayName]));

    const schedule: EventOpportunity[] = perEvent
      .map(({ event, scoreByGuest }) => {
        const topGuests: TopGuest[] = [...scoreByGuest.entries()]
          .map(([guestId, affinityScore]) => ({
            guestId,
            displayName: nameById.get(guestId) ?? null,
            affinityScore,
          }))
          .sort((a, b) => b.affinityScore - a.affinityScore)
          .slice(0, TOP_GUESTS_PER_EVENT);

        return {
          eventId: event.id,
          eventName: event.name,
          eventDate: event.date ? event.date.toISOString() : null,
          matchedGuests: scoreByGuest.size,
          topGuests,
          suggestedSendWindow: sendWindowFor(event.date),
        };
      })
      // Rank: most matched guests first, then heavier aggregate demand, then
      // the soonest dated event (undated sinks below dated ties).
      .sort((a, b) => {
        if (b.matchedGuests !== a.matchedGuests) {
          return b.matchedGuests - a.matchedGuests;
        }
        const aTop = a.topGuests.reduce((s, g) => s + g.affinityScore, 0);
        const bTop = b.topGuests.reduce((s, g) => s + g.affinityScore, 0);
        if (bTop !== aTop) return bTop - aTop;
        const at = a.eventDate ? Date.parse(a.eventDate) : Infinity;
        const bt = b.eventDate ? Date.parse(b.eventDate) : Infinity;
        return at - bt;
      });

    return {
      feature: 'event-timed-offers',
      withinDays: withinDays ?? null,
      note:
        'Planning/analysis only — no sends (dispatch stays with the win-back ' +
        'trigger). Entity has no date column; event dates are read best-effort ' +
        `from metadata (${datedCount}/${candidates.length} candidates dated). ` +
        'Undated events are always candidates and carry an "undated" send window.',
      generatedAt: new Date(now).toISOString(),
      schedule,
    };
  }
}

@ApiTags('mkt:offers')
@Controller('offers')
export class EventOffersController {
  constructor(private readonly svc: EventOffersService) {}

  @Get('event-timed')
  @Scopes('mkt:reporting:read')
  eventTimed(
    @Tenant() ctx: TenantContext,
    @Query('withinDays') withinDays?: string,
  ) {
    const parsed =
      withinDays !== undefined ? Number.parseInt(withinDays, 10) : undefined;
    return this.svc.eventTimedOffers(
      ctx,
      parsed !== undefined && Number.isFinite(parsed) ? parsed : undefined,
    );
  }
}

@Module({
  controllers: [EventOffersController],
  providers: [EventOffersService],
  exports: [EventOffersService],
})
export class EventOffersModule {}
