import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface TasteSignal {
  subjectType: 'artist' | 'genre' | 'venue';
  subjectRef: string;
  externalId: string;
  weight: number;
}

/**
 * Spotify adapter — the highest-signal taste connector. STUB mode returns a
 * deterministic sample library so onboarding + discovery work without OAuth.
 */
@Injectable()
export class SpotifyAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.spotifyClientId');
  }

  authorizeUrl(state: string): string {
    if (this.stub) return `https://stub.local/spotify/authorize?state=${state}`;
    const clientId = this.config.get<string>('connectors.spotifyClientId');
    const redirect = this.config.get<string>('connectors.spotifyRedirectUrl');
    const p = new URLSearchParams({
      client_id: clientId ?? '',
      response_type: 'code',
      redirect_uri: redirect ?? '',
      scope: 'user-top-read user-read-email',
      state,
      show_dialog: 'false',
    });
    return `https://accounts.spotify.com/authorize?${p.toString()}`;
  }

  /** Server-side code→token exchange. Never accepts tokens from the client. */
  async exchangeCode(code: string): Promise<string> {
    if (this.stub) return 'stub';
    const clientId = this.config.get<string>('connectors.spotifyClientId');
    const secret = this.config.get<string>('connectors.spotifyClientSecret');
    const redirect = this.config.get<string>('connectors.spotifyRedirectUrl');
    const res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization:
          'Basic ' + Buffer.from(`${clientId}:${secret}`).toString('base64'),
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect ?? '',
      }),
    });
    if (!res.ok) {
      throw new Error(`spotify token exchange ${res.status}`);
    }
    const token = (await res.json()) as { access_token?: string };
    if (!token.access_token) throw new Error('spotify token missing');
    return token.access_token;
  }

  /** Fetch top artists/genres for a connected account. Stubbed deterministically. */
  async fetchTaste(_accessToken: string): Promise<TasteSignal[]> {
    if (this.stub) {
      return [
        {
          subjectType: 'artist',
          subjectRef: 'Keinemusik',
          externalId: 'sp_keinemusik',
          weight: 3,
        },
        {
          subjectType: 'artist',
          subjectRef: 'Black Coffee',
          externalId: 'sp_blackcoffee',
          weight: 2.5,
        },
        {
          subjectType: 'genre',
          subjectRef: 'afro house',
          externalId: 'sp_afrohouse',
          weight: 3,
        },
        {
          subjectType: 'genre',
          subjectRef: 'melodic house',
          externalId: 'sp_melodic',
          weight: 1.5,
        },
      ];
    }
    // Live: top artists (medium term) → artist + aggregated genre signals.
    const res = await fetch(
      'https://api.spotify.com/v1/me/top/artists?limit=30&time_range=medium_term',
      { headers: { Authorization: `Bearer ${_accessToken}` } },
    );
    if (!res.ok) throw new Error(`spotify top artists ${res.status}`);
    const body = (await res.json()) as {
      items?: { id: string; name: string; genres?: string[] }[];
    };
    const items = body.items ?? [];
    const signals: TasteSignal[] = [];
    const genreCounts = new Map<string, number>();
    items.forEach((a, i) => {
      signals.push({
        subjectType: 'artist',
        subjectRef: a.name,
        externalId: a.id,
        // rank 1 → 5 … rank 30 → 1
        weight: Math.max(1, Math.round((30 - i) / 6)),
      });
      for (const g of a.genres ?? []) {
        const key = g.toLowerCase();
        genreCounts.set(key, (genreCounts.get(key) ?? 0) + 1);
      }
    });
    [...genreCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .forEach(([genre, count]) => {
        signals.push({
          subjectType: 'genre',
          subjectRef: genre,
          externalId: `genre:${genre}`,
          weight: Math.min(5, count),
        });
      });
    return signals;
  }
}
