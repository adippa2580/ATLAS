import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TasteSignal } from './spotify.adapter';

/**
 * Apple Music adapter — Phase-02 taste connector.
 *
 * Apple Music does NOT use a server redirect OAuth flow. The app identifies
 * itself with a long-lived *developer token* (an ES256 JWT held in config), and
 * the guest authorizes client-side via MusicKit JS, which returns a short-lived
 * *Music User Token*. That user token is what reaches our callback (in the same
 * `code` slot the OAuth connectors use); there is no server-side code exchange,
 * so exchangeCode just passes it through. fetchTaste then calls the Apple Music
 * API with BOTH tokens — developer token as the Bearer, user token in the
 * `Music-User-Token` header — and reads the guest's library artists + genres.
 *
 * STUB mode (no developer token) returns a deterministic library so onboarding
 * + discovery work without credentials, exactly like the other connectors.
 */
@Injectable()
export class AppleMusicAdapter {
  constructor(private readonly config: ConfigService) {}

  private get developerToken(): string {
    return this.config.get<string>('connectors.appleMusicDeveloperToken') ?? '';
  }

  private get stub(): boolean {
    return !this.developerToken;
  }

  /**
   * Apple authorization is client-side (MusicKit JS). In live mode we point the
   * guest at the Atlas-hosted MusicKit authorize page, which runs the MusicKit
   * handshake and posts the resulting Music User Token back to the callback.
   */
  authorizeUrl(state: string): string {
    if (this.stub) {
      return `https://stub.local/applemusic/authorize?state=${state}`;
    }
    return `/connect/applemusic?state=${encodeURIComponent(state)}`;
  }

  /**
   * No server-side exchange for Apple Music — the `code` IS the Music User
   * Token minted client-side by MusicKit. Pass it through so the callback can
   * use it as the `Music-User-Token`.
   */
  async exchangeCode(code: string): Promise<string> {
    return this.stub ? 'stub' : code;
  }

  /** Library artists + their genres → taste signals. Stubbed deterministically. */
  async fetchTaste(userToken: string): Promise<TasteSignal[]> {
    if (this.stub) {
      return [
        {
          subjectType: 'artist',
          subjectRef: 'Keinemusik',
          externalId: 'am_keinemusik',
          weight: 3,
        },
        {
          subjectType: 'artist',
          subjectRef: 'Rampa',
          externalId: 'am_rampa',
          weight: 2,
        },
        {
          subjectType: 'genre',
          subjectRef: 'afro house',
          externalId: 'am_afrohouse',
          weight: 3,
        },
        {
          subjectType: 'genre',
          subjectRef: 'deep house',
          externalId: 'am_deephouse',
          weight: 1.5,
        },
      ];
    }
    // Live: library artists (developer token + the guest's Music User Token).
    const res = await fetch(
      'https://api.music.apple.com/v1/me/library/artists?limit=50',
      {
        headers: {
          Authorization: `Bearer ${this.developerToken}`,
          'Music-User-Token': userToken,
        },
      },
    );
    if (!res.ok) throw new Error(`apple music library artists ${res.status}`);
    const body = (await res.json()) as {
      data?: { id?: string; attributes?: { name?: string } }[];
    };
    const artists = body.data ?? [];
    const signals: TasteSignal[] = [];
    artists.forEach((a, i) => {
      const name = a.attributes?.name;
      if (!name) return;
      signals.push({
        subjectType: 'artist',
        subjectRef: name,
        externalId: `am:${a.id ?? name}`,
        // rank 1 → 5 … rank 50 → 1
        weight: Math.max(1, Math.round((50 - i) / 10)),
      });
    });
    return signals;
  }
}
