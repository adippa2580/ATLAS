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

  /** OAuth is configured once a client id is present (redirect defaults sanely). */
  get oauthConfigured(): boolean {
    return !!this.config.get<string>('connectors.eventbriteClientId');
  }

  /**
   * The Eventbrite OAuth2 authorize URL — where a person consents to ATLAS
   * reading their organisation's events. `state` is the CSRF nonce the caller
   * issued; it must round-trip back to the callback. When no client id is set
   * the flow is stubbed: we point back at our own callback with a stub code so
   * the whole handshake is walkable without credentials (mirrors the rest of
   * the stub-first connector fleet).
   */
  authorizeUrl(state: string): string {
    const clientId = this.config.get<string>('connectors.eventbriteClientId');
    const redirect =
      this.config.get<string>('connectors.eventbriteRedirectUrl') ??
      '/v1/connectors/eventbrite/callback';
    if (!clientId) {
      return `${redirect}?code=stub_authorization_code&state=${encodeURIComponent(state)}`;
    }
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirect,
      state,
    });
    return `https://www.eventbrite.com/oauth/authorize?${params.toString()}`;
  }

  /**
   * Exchange an OAuth `code` for an access token. Stubbed when the OAuth trio is
   * unset — returns a deterministic stub token so the callback completes; live
   * mode (client id + secret set) is intentionally unimplemented in this build.
   */
  async exchangeCode(code: string): Promise<string> {
    if (!this.oauthConfigured) {
      return `ebo_stub_token_${code}`;
    }
    throw new Error(
      'Eventbrite live OAuth exchange not configured in this build',
    );
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
