import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DemandSignal } from './connector.types';

/**
 * Google Calendar adapter — ingests calendar events as demand/event signals.
 * STUB mode returns a deterministic sample feed so onboarding + demand
 * insights work without OAuth. Live mode is OAuth-gated (calendar.readonly).
 */
@Injectable()
export class GoogleCalendarAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.googleCalendarClientId');
  }

  authorizeUrl(state: string): string {
    if (this.stub) return `https://stub.local/gcal/authorize?state=${state}`;
    const clientId = this.config.get<string>(
      'connectors.googleCalendarClientId',
    );
    const scope = encodeURIComponent(
      'https://www.googleapis.com/auth/calendar.readonly',
    );
    return (
      `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}` +
      `&state=${state}&response_type=code&scope=${scope}` +
      `&access_type=offline&prompt=consent`
    );
  }

  /** Fetch upcoming calendar events for a connected account. Stubbed deterministically. */
  async fetchEvents(_accessToken: string): Promise<DemandSignal[]> {
    if (this.stub) {
      return [
        {
          externalEventId: 'gcal_evt_launch',
          name: 'Rooftop Launch Party',
          subjectType: 'event',
          subjectRef: 'Rooftop Launch Party',
          startsAt: '2026-08-01T19:00:00.000Z',
          demandWeight: 42,
          venueHint: 'Sydney CBD',
        },
        {
          externalEventId: 'gcal_evt_supperclub',
          name: 'Supper Club Tasting',
          subjectType: 'event',
          subjectRef: 'Supper Club Tasting',
          startsAt: '2026-08-05T18:30:00.000Z',
          demandWeight: 12,
          venueHint: 'Surry Hills',
        },
        {
          externalEventId: 'gcal_evt_djset',
          name: 'Afro House DJ Set',
          subjectType: 'event',
          subjectRef: 'Afro House DJ Set',
          startsAt: '2026-08-09T21:00:00.000Z',
          demandWeight: 30,
          venueHint: 'Marrickville',
        },
        {
          externalEventId: 'gcal_evt_brunch',
          name: 'Bottomless Brunch',
          subjectType: 'event',
          subjectRef: 'Bottomless Brunch',
          startsAt: '2026-08-10T11:00:00.000Z',
          demandWeight: 8,
          venueHint: 'Bondi Beach',
        },
      ];
    }
    throw new Error('Google Calendar live mode not configured in this build');
  }

  /**
   * Normalise a Google Calendar event resource into a DemandSignal. Defensive
   * on field-name variants (summary/title, start.dateTime/start.date/start,
   * id/eventId, location/venue, attendees length).
   */
  normalizeEvent(body: any): DemandSignal {
    const src = body ?? {};
    const externalEventId = String(src.id ?? src.eventId ?? src.iCalUID ?? '');
    const name = String(src.summary ?? src.title ?? 'Untitled event');

    const start = src.start ?? {};
    const startsAt =
      typeof start === 'string'
        ? start
        : (start.dateTime ?? start.date ?? src.startsAt ?? undefined);

    const attendees = Array.isArray(src.attendees) ? src.attendees : undefined;
    const demandWeight =
      attendees && attendees.length > 0 ? attendees.length : 1;

    const venueHint = src.location ?? src.venue ?? undefined;

    return {
      externalEventId,
      name,
      subjectType: 'event',
      subjectRef: name,
      startsAt: startsAt ? String(startsAt) : undefined,
      demandWeight,
      venueHint: venueHint ? String(venueHint) : undefined,
    };
  }
}
