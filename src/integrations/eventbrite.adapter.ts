import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DemandSignal } from './connector.types';

/**
 * Eventbrite demand-signal adapter. Ingests ticketed events as latent-demand
 * signals (not bookings): each event's capacity/sold becomes a demandWeight the
 * discovery layer uses to spot where audience interest is clustering.
 *
 * STUB mode when EVENTBRITE_API_TOKEN is unset — returns a deterministic sample
 * set so onboarding + demand insights work without OAuth, mirroring the Spotify
 * taste connector's stub pattern.
 */
@Injectable()
export class EventbriteAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.eventbriteApiToken');
  }

  /**
   * Fetch upcoming events for an org/venue as demand signals. Stubbed
   * deterministically; live mode is intentionally unimplemented in this build.
   */
  async fetchDemand(_orgOrVenueId: string): Promise<DemandSignal[]> {
    if (this.stub) {
      return [
        {
          externalEventId: 'eb_evt_101',
          name: 'Keinemusik Warehouse Session',
          subjectType: 'event',
          subjectRef: 'Keinemusik Warehouse Session',
          startsAt: '2026-08-14T21:00:00.000Z',
          demandWeight: 800,
          venueHint: 'Sydney',
        },
        {
          externalEventId: 'eb_evt_102',
          name: 'Black Coffee — Afro House Night',
          subjectType: 'artist',
          subjectRef: 'Black Coffee',
          startsAt: '2026-08-21T22:00:00.000Z',
          demandWeight: 1200,
          venueHint: 'Melbourne',
        },
        {
          externalEventId: 'eb_evt_103',
          name: 'Sunset Rooftop Sessions',
          subjectType: 'event',
          subjectRef: 'Sunset Rooftop Sessions',
          startsAt: '2026-08-28T18:30:00.000Z',
          demandWeight: 350,
          venueHint: 'Sydney',
        },
        {
          externalEventId: 'eb_evt_104',
          name: 'Peggy Gou Live',
          subjectType: 'artist',
          subjectRef: 'Peggy Gou',
          startsAt: '2026-09-05T21:30:00.000Z',
          demandWeight: 1500,
          venueHint: 'Brisbane',
        },
      ];
    }
    throw new Error('Eventbrite live mode not configured in this build');
  }

  /**
   * Normalise a raw Eventbrite event object into the shared DemandSignal.
   * Defensive on field-name variants (name.text vs name, start.utc vs
   * start_utc, capacity vs capacity_is_custom sold). demandWeight is derived
   * from capacity (Number, default 0).
   */
  normalizeEvent(body: any): DemandSignal {
    const name: string =
      body?.name?.text ?? body?.name ?? body?.title ?? 'Untitled event';
    const startsAt: string | undefined =
      body?.start?.utc ?? body?.start_utc ?? body?.startsAt ?? body?.start;
    const capacity = Number(
      body?.capacity ?? body?.ticket_capacity ?? body?.sold ?? 0,
    );
    const venueHint: string | undefined =
      body?.venue?.name ??
      body?.venue?.address?.city ??
      body?.venueHint ??
      body?.venue;

    return {
      externalEventId: String(body?.id ?? body?.event_id ?? 'eb_evt_stub'),
      name,
      subjectType: 'event',
      subjectRef: name,
      startsAt,
      demandWeight: Number.isFinite(capacity) ? capacity : 0,
      venueHint: typeof venueHint === 'string' ? venueHint : undefined,
    };
  }
}
