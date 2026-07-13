import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TasteSignal } from './spotify.adapter';

/**
 * Instagram adapter — taste (scenes/venues/people) + attribution. Second taste
 * connector, earned at a moment of value (not at signup). STUB mode deterministic.
 */
@Injectable()
export class InstagramAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.instagramClientId');
  }

  authorizeUrl(state: string): string {
    if (this.stub)
      return `https://stub.local/instagram/authorize?state=${state}`;
    const clientId = this.config.get<string>('connectors.instagramClientId');
    return `https://api.instagram.com/oauth/authorize?client_id=${clientId}&state=${state}`;
  }

  async fetchTaste(_accessToken: string): Promise<TasteSignal[]> {
    if (this.stub) {
      return [
        {
          subjectType: 'venue',
          subjectRef: 'Gallery',
          externalId: 'ig_gallery',
          weight: 1.5,
        },
        {
          subjectType: 'artist',
          subjectRef: 'ANOTR',
          externalId: 'ig_anotr',
          weight: 2,
        },
      ];
    }
    throw new Error('Instagram live mode not configured in this build');
  }
}
