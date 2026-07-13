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
    return `https://accounts.spotify.com/authorize?client_id=${clientId}&state=${state}&scope=user-top-read`;
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
    throw new Error('Spotify live mode not configured in this build');
  }
}
