import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SignJWT, importPKCS8 } from 'jose';
import { TasteSignal } from './spotify.adapter';

/**
 * Apple Music adapter — Phase-02 taste connector.
 *
 * Apple Music uses a TWO-token model (verified against the Apple Music API docs):
 *  - Developer token: an app-level ES256 JWT (kid = Key ID, iss = Team ID, iat,
 *    exp ≤ 6 months). We mint + rotate it server-side from the .p8 MusicKit
 *    private key via `jose`. A pre-minted token may be supplied instead.
 *  - Music User Token: per-user, obtained CLIENT-SIDE via MusicKit JS
 *    (`music.authorize()`). The server cannot mint it; it reaches us through the
 *    /connect/applemusic browser leg and is passed as `Music-User-Token`.
 *
 * Taste is read with BOTH tokens: heavy rotation (the closest proxy to Spotify's
 * "top artists" — Apple has no time-windowed top endpoint) plus library artists.
 *
 * STUB mode when neither a developer token nor the signing trio is configured:
 * returns a deterministic library so onboarding + discovery work without creds.
 */
@Injectable()
export class AppleMusicAdapter {
  private readonly logger = new Logger(AppleMusicAdapter.name);

  private static readonly API = 'https://api.music.apple.com/v1';
  // Apple caps developer-token lifetime at 6 months; mint for ~150 days and
  // rotate a day before expiry so a long-lived instance never serves a stale one.
  private static readonly TOKEN_TTL_SECONDS = 150 * 24 * 60 * 60;
  private static readonly ROTATE_BEFORE_SECONDS = 24 * 60 * 60;

  private cachedToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private cfg(key: string): string {
    return this.config.get<string>(`connectors.${key}`) ?? '';
  }

  /** True when we can produce a developer token (pre-minted or mintable). */
  private get configured(): boolean {
    if (this.cfg('appleMusicDeveloperToken')) return true;
    return !!(
      this.cfg('appleMusicTeamId') &&
      this.cfg('appleMusicKeyId') &&
      this.cfg('appleMusicPrivateKey')
    );
  }

  private get stub(): boolean {
    return !this.configured;
  }

  /**
   * The app-level developer token: a supplied one wins; otherwise mint (and
   * cache) an ES256 JWT from the signing trio. Public so the /connect page can
   * hand it to MusicKit JS (the developer token is app-level and browser-safe;
   * only the .p8 private key is secret).
   */
  async developerToken(
    nowSeconds = Math.floor(Date.now() / 1000),
  ): Promise<string> {
    const supplied = this.cfg('appleMusicDeveloperToken');
    if (supplied) return supplied;

    if (
      this.cachedToken &&
      this.cachedToken.expiresAt - AppleMusicAdapter.ROTATE_BEFORE_SECONDS >
        nowSeconds
    ) {
      return this.cachedToken.value;
    }

    const teamId = this.cfg('appleMusicTeamId');
    const keyId = this.cfg('appleMusicKeyId');
    const pem = this.cfg('appleMusicPrivateKey');
    if (!teamId || !keyId || !pem) {
      throw new Error('apple music developer token not configured');
    }

    const key = await importPKCS8(pem, 'ES256');
    const exp = nowSeconds + AppleMusicAdapter.TOKEN_TTL_SECONDS;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid: keyId, typ: 'JWT' })
      .setIssuer(teamId)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(exp)
      .sign(key);
    this.cachedToken = { value: token, expiresAt: exp };
    return token;
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
    return `/v1/connectors/applemusic/connect?state=${encodeURIComponent(state)}`;
  }

  /**
   * No server-side exchange for Apple Music — the `code` IS the Music User
   * Token minted client-side by MusicKit. Pass it through so the callback can
   * use it as the `Music-User-Token`.
   */
  async exchangeCode(code: string): Promise<string> {
    return this.stub ? 'stub' : code;
  }

  /**
   * Heavy rotation + library artists → taste signals. Heavy rotation is Apple's
   * closest proxy to "top artists" (no time-windowed top endpoint exists); we
   * fold in library artists for coverage. Stubbed deterministically.
   */
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

    const devToken = await this.developerToken();
    const headers = {
      Authorization: `Bearer ${devToken}`,
      'Music-User-Token': userToken,
    };

    const byRef = new Map<string, TasteSignal>();
    const add = (name: string, id: string, weight: number) => {
      const ref = name.trim();
      if (!ref) return;
      const prev = byRef.get(ref.toLowerCase());
      if (!prev || weight > prev.weight) {
        byRef.set(ref.toLowerCase(), {
          subjectType: 'artist',
          subjectRef: ref,
          externalId: id,
          weight,
        });
      }
    };

    // Heavy rotation: most-played resources. Rank-weighted 5→1. Artist names
    // come from artistName on album/playlist resources.
    try {
      const res = await fetch(
        `${AppleMusicAdapter.API}/me/history/heavy-rotation?limit=10`,
        { headers },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { id?: string; attributes?: { artistName?: string } }[];
        };
        (body.data ?? []).forEach((r, i) => {
          const name = r.attributes?.artistName;
          if (name) add(name, `am:hr:${r.id ?? name}`, Math.max(1, 5 - i));
        });
      } else {
        this.logger.warn(`[applemusic] heavy-rotation ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(
        `[applemusic] heavy-rotation failed: ${(err as Error).message}`,
      );
    }

    // Library artists: broad coverage, lower weight than heavy rotation.
    try {
      const res = await fetch(
        `${AppleMusicAdapter.API}/me/library/artists?limit=50`,
        { headers },
      );
      if (res.ok) {
        const body = (await res.json()) as {
          data?: { id?: string; attributes?: { name?: string } }[];
        };
        (body.data ?? []).forEach((a) => {
          const name = a.attributes?.name;
          if (name) add(name, `am:lib:${a.id ?? name}`, 1);
        });
      } else {
        this.logger.warn(`[applemusic] library artists ${res.status}`);
      }
    } catch (err) {
      this.logger.warn(
        `[applemusic] library artists failed: ${(err as Error).message}`,
      );
    }

    return [...byRef.values()];
  }
}
