import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DemandSignal } from './connector.types';

/**
 * Resident Advisor demand-signal adapter — the electronic-music event authority
 * & ticketing source. RA is the canonical calendar for club/festival culture:
 * events, the artists on the bill, the promoters running them, the venues, and
 * the ticket links. This adapter reads that calendar and normalises each listing
 * into the shared {@link DemandSignal} so the discovery layer can reason about
 * where electronic-music demand is clustering.
 *
 * ATLAS mapping
 * -------------
 * - RA event → DemandSignal(subjectType='event') / catalog Entity(kind=event);
 *   the ticket link rides along as the actionable listing.
 * - RA artist on a bill → DemandSignal(subjectType='artist') / Entity(kind=artist);
 *   these are matched to guests via the A-List (an artist a guest follows playing
 *   near a venue is a first-class discovery signal — discovery, never a blast).
 * - RA venue / promoter → venueHint + catalog Entity(kind=venue|promoter),
 *   grounding "who runs what, where".
 * - interested/attending counts → demandWeight: the relative heat of a listing,
 *   feeding latent-demand insights (not bookings).
 * - The RA calendar as a whole → competitor & genre-saturation analysis: a dense
 *   run of the same genre on the same nights around a venue is the saturation the
 *   operator needs to see when planning a date. Normalisation + a stable dedupe
 *   key let RA and Ticketmaster listings of the *same* show collapse to one row
 *   before that analysis runs.
 *
 * RA is read/poll only — there is no inbound webhook. The value is calendar
 * analysis, so this adapter fetches and normalises; it never receives events.
 *
 * STUB mode when RESIDENT_ADVISOR_API_KEY is unset — returns a deterministic
 * slate of electronic events so onboarding + demand insights work without
 * credentials, mirroring every other connector in the platform. Live mode is
 * intentionally unimplemented in this build.
 *
 * Built for KAN-10.
 */
@Injectable()
export class ResidentAdvisorAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.residentAdvisorApiKey');
  }

  /**
   * Fetch upcoming electronic-music events for an area as demand signals.
   * Stubbed deterministically (artists + promoters + venues, demandWeight
   * derived from interest/attending); live mode is intentionally unimplemented.
   */
  async fetchEvents(area?: string): Promise<DemandSignal[]> {
    if (this.stub) {
      const venueHint = area ?? 'Berlin';
      return [
        {
          externalEventId: 'ra_evt_501',
          name: 'Klockworks Night w/ Ben Klock',
          subjectType: 'artist',
          subjectRef: 'Ben Klock',
          startsAt: '2026-08-15T23:00:00.000Z',
          demandWeight: 2400,
          venueHint,
        },
        {
          externalEventId: 'ra_evt_502',
          name: 'Dekmantel Selectors — Amsterdam Warehouse',
          subjectType: 'event',
          subjectRef: 'Dekmantel Selectors — Amsterdam Warehouse',
          startsAt: '2026-08-22T22:00:00.000Z',
          demandWeight: 1800,
          venueHint,
        },
        {
          externalEventId: 'ra_evt_503',
          name: 'Amelie Lens presents EXHALE',
          subjectType: 'artist',
          subjectRef: 'Amelie Lens',
          startsAt: '2026-08-29T22:30:00.000Z',
          demandWeight: 3100,
          venueHint,
        },
        {
          externalEventId: 'ra_evt_504',
          name: 'Sunwaves Open Air',
          subjectType: 'event',
          subjectRef: 'Sunwaves Open Air',
          startsAt: '2026-09-05T16:00:00.000Z',
          demandWeight: 950,
          venueHint,
        },
      ];
    }
    throw new Error('Resident Advisor live mode not configured in this build');
  }

  /**
   * Normalise a raw Resident Advisor event object into the shared DemandSignal.
   * Defensive on field-name variants across RA's REST/GraphQL shapes: id, the
   * event title (title vs name), the headline artist (artists[] → subjectRef),
   * start time (date vs startTime vs startsAt), the demand counts
   * (interestedCount/attending → demandWeight) and the venue/area (venue.name vs
   * area vs venueHint → venueHint).
   */
  normalizeEvent(body: any): DemandSignal {
    const title: string =
      body?.title ?? body?.name ?? body?.event?.title ?? 'Untitled event';

    const artists: unknown = body?.artists ?? body?.lineup ?? body?.artist;
    const headliner: string | undefined = Array.isArray(artists)
      ? artists
          .map((a: any) => (typeof a === 'string' ? a : a?.name))
          .find((n: unknown): n is string => typeof n === 'string' && !!n)
      : typeof artists === 'string'
        ? artists
        : undefined;

    const subjectType: DemandSignal['subjectType'] = headliner
      ? 'artist'
      : 'event';
    const subjectRef: string = headliner ?? title;

    const startsAt: string | undefined =
      body?.date ?? body?.startTime ?? body?.startsAt ?? body?.start;

    const demand = Number(
      body?.interestedCount ??
        body?.attending ??
        body?.interested ??
        body?.rsvpCount ??
        0,
    );

    const venueRaw: unknown =
      body?.venue?.name ?? body?.venue ?? body?.area ?? body?.venueHint;
    const venueHint: string | undefined =
      typeof venueRaw === 'string' ? venueRaw : undefined;

    return {
      externalEventId: String(body?.id ?? body?.eventId ?? 'ra_evt_stub'),
      name: title,
      subjectType,
      subjectRef,
      startsAt: typeof startsAt === 'string' ? startsAt : undefined,
      demandWeight: Number.isFinite(demand) ? demand : 0,
      venueHint,
    };
  }

  /**
   * Stable dedupe key: day + venue + subject. The same show is often listed on
   * both Resident Advisor and Ticketmaster; keying on the event day, the venue
   * hint and the subject lets those cross-source listings collapse to one row so
   * competitor / genre-saturation analysis in Atlas isn't double-counting.
   */
  dedupeKey(sig: DemandSignal): string {
    return `${(sig.startsAt ?? '').slice(0, 10)}|${sig.venueHint ?? ''}|${sig.subjectRef}`;
  }

  /**
   * Collapse duplicate signals (same day + venue + subject) keeping the highest
   * demandWeight per key — the strongest reading of a show survives the merge.
   */
  dedupe(signals: DemandSignal[]): DemandSignal[] {
    const best = new Map<string, DemandSignal>();
    for (const sig of signals) {
      const key = this.dedupeKey(sig);
      const current = best.get(key);
      if (!current || sig.demandWeight > current.demandWeight) {
        best.set(key, sig);
      }
    }
    return [...best.values()];
  }
}
