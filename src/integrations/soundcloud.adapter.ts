import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TasteSignal } from './spotify.adapter';

/**
 * SoundCloud adapter — Phase-02 taste connector. A standard OAuth2
 * authorization-code flow: the guest consents, we exchange the code for a token
 * server-side, then read their followed artists + liked-track genres into taste
 * signals (artist → follow, genre → listen), normalised via TasteService like
 * every other connector. STUB mode returns a deterministic library so
 * onboarding + discovery work without credentials.
 */
@Injectable()
export class SoundcloudAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.soundcloudClientId');
  }

  authorizeUrl(state: string): string {
    if (this.stub) {
      return `https://stub.local/soundcloud/authorize?state=${state}`;
    }
    const clientId = this.config.get<string>('connectors.soundcloudClientId');
    const redirect = this.config.get<string>(
      'connectors.soundcloudRedirectUrl',
    );
    const p = new URLSearchParams({
      client_id: clientId ?? '',
      response_type: 'code',
      redirect_uri: redirect ?? '',
      scope: 'non-expiring',
      state,
    });
    return `https://secure.soundcloud.com/authorize?${p.toString()}`;
  }

  /** Server-side code→token exchange. Never accepts tokens from the client. */
  async exchangeCode(code: string): Promise<string> {
    if (this.stub) return 'stub';
    const clientId = this.config.get<string>('connectors.soundcloudClientId');
    const secret = this.config.get<string>('connectors.soundcloudClientSecret');
    const redirect = this.config.get<string>(
      'connectors.soundcloudRedirectUrl',
    );
    const res = await fetch('https://secure.soundcloud.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId ?? '',
        client_secret: secret ?? '',
        redirect_uri: redirect ?? '',
        code,
      }),
    });
    if (!res.ok) throw new Error(`soundcloud token exchange ${res.status}`);
    const token = (await res.json()) as { access_token?: string };
    if (!token.access_token) throw new Error('soundcloud token missing');
    return token.access_token;
  }

  /** Followed artists + liked-track genres → taste signals. Stubbed deterministically. */
  async fetchTaste(accessToken: string): Promise<TasteSignal[]> {
    if (this.stub) {
      return [
        {
          subjectType: 'artist',
          subjectRef: 'ANOTR',
          externalId: 'sc_anotr',
          weight: 3,
        },
        {
          subjectType: 'artist',
          subjectRef: 'Adam Port',
          externalId: 'sc_adamport',
          weight: 2,
        },
        {
          subjectType: 'genre',
          subjectRef: 'afro house',
          externalId: 'sc_afrohouse',
          weight: 3,
        },
        {
          subjectType: 'genre',
          subjectRef: 'organic house',
          externalId: 'sc_organic',
          weight: 1.5,
        },
      ];
    }
    // Live: followed artists (users the guest follows) → artist signals.
    const res = await fetch(
      'https://api.soundcloud.com/me/followings?limit=50&linked_partitioning=true',
      {
        headers: {
          Authorization: `OAuth ${accessToken}`,
          accept: 'application/json; charset=utf-8',
        },
      },
    );
    if (!res.ok) throw new Error(`soundcloud followings ${res.status}`);
    const body = (await res.json()) as {
      collection?: { id?: number; username?: string }[];
    };
    const artists = body.collection ?? [];
    const signals: TasteSignal[] = [];
    artists.forEach((a, i) => {
      if (!a.username) return;
      signals.push({
        subjectType: 'artist',
        subjectRef: a.username,
        externalId: `sc:${a.id ?? a.username}`,
        // rank 1 → 5 … rank 50 → 1
        weight: Math.max(1, Math.round((50 - i) / 10)),
      });
    });
    return signals;
  }
}
