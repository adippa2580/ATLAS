import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArtistIntel } from './connector.types';

/**
 * Soundcharts artist-intelligence adapter (or Chartmetric — same ArtistIntel
 * contract). Read-only music-data connector: given an artist id or name it
 * returns streaming, social, geographic and momentum signals normalised to the
 * shared {@link ArtistIntel} shape.
 *
 * ATLAS mapping: the returned ArtistIntel enriches an Entity(kind=artist)'s
 * metadata with streaming/social/geo/momentum signals. Discovery then ranks
 * artists by audience fit — matching an artist's streaming footprint and top
 * markets against a venue's customer base and the A-List taste graph — so
 * operators see who resonates with their crowd, not just who is famous.
 *
 * STUB mode when connectors.soundchartsApiKey is unset — returns deterministic
 * intelligence so onboarding, ranking and fit insights work without a
 * credential, mirroring the other stub-first connectors. Live mode is
 * intentionally unimplemented in this build.
 *
 * Built for KAN-7.
 */
@Injectable()
export class SoundchartsAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.soundchartsApiKey');
  }

  /**
   * Fetch artist intelligence for a single artist id or name. Stubbed
   * deterministically; live mode is intentionally unimplemented in this build.
   */
  async fetchArtist(idOrName: string): Promise<ArtistIntel> {
    if (this.stub) {
      return this.stubArtist(idOrName);
    }
    throw new Error('Soundcharts live mode not configured in this build');
  }

  /**
   * Rank a set of artists by audience fit. Stub maps each name to a
   * deterministic ArtistIntel and returns them sorted by fitScore descending
   * (strongest fit first). Live mode is intentionally unimplemented.
   */
  async rankArtists(names: string[]): Promise<ArtistIntel[]> {
    if (this.stub) {
      return names
        .map((name) => this.stubArtist(name))
        .sort((a, b) => (b.fitScore ?? 0) - (a.fitScore ?? 0));
    }
    throw new Error('Soundcharts live mode not configured in this build');
  }

  /**
   * Normalise a raw Soundcharts/Chartmetric artist object into the shared
   * ArtistIntel. Defensive on field-name variants across vendors. `momentum`
   * is clamped to −1..1 and `fitScore` to 0..1.
   */
  normalizeArtist(body: any): ArtistIntel {
    const externalArtistId = String(
      body?.uuid ?? body?.id ?? body?.artist_id ?? 'sc_artist_stub',
    );
    const name: string = body?.name ?? body?.artist_name ?? 'Unknown artist';

    const genres: string[] | undefined = Array.isArray(body?.genres)
      ? body.genres.map((g: unknown) => String(g))
      : undefined;

    const monthlyListeners = toNumber(
      body?.monthly_listeners ?? body?.monthlyListeners,
    );
    const followers = toNumber(body?.followers);
    const momentumRaw = toNumber(body?.momentum ?? body?.growth);
    const fitRaw = toNumber(body?.fit ?? body?.fitScore);

    const markets =
      body?.markets ?? body?.top_markets ?? body?.audience_geo ?? undefined;
    const topMarkets: string[] | undefined = Array.isArray(markets)
      ? markets.map((m: unknown) => String(m))
      : undefined;

    return {
      externalArtistId,
      name,
      genres,
      monthlyListeners,
      followers,
      momentum:
        momentumRaw === undefined ? undefined : clamp(momentumRaw, -1, 1),
      topMarkets,
      fitScore: fitRaw === undefined ? undefined : clamp(fitRaw, 0, 1),
    };
  }

  /**
   * Deterministic per-name intelligence used by both stub entry points. A
   * stable string hash drives every metric so repeated calls are identical and
   * distinct names get distinct fitScores.
   */
  private stubArtist(idOrName: string): ArtistIntel {
    const seed = hash(idOrName);
    const genrePool = [
      'afro house',
      'melodic techno',
      'organic house',
      'deep house',
      'indie dance',
    ];
    const marketPool = ['AU', 'GB', 'US', 'DE', 'BR', 'ZA'];

    const g0 = genrePool[seed % genrePool.length];
    const g1 = genrePool[(seed >> 3) % genrePool.length];
    const m0 = marketPool[seed % marketPool.length];
    const m1 = marketPool[(seed >> 2) % marketPool.length];

    return this.normalizeArtist({
      id: `sc_${seed.toString(36)}`,
      name: idOrName,
      genres: g0 === g1 ? [g0] : [g0, g1],
      monthly_listeners: 50_000 + (seed % 4_000_000),
      followers: 10_000 + (seed % 800_000),
      momentum: ((seed % 200) - 100) / 100, // −1..0.99
      top_markets: m0 === m1 ? [m0] : [m0, m1],
      fit: (seed % 1000) / 1000, // 0..0.999, distinct per name
    });
  }
}

/** Coerce to a finite number, or undefined when absent/non-numeric. */
function toNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/** Clamp a number into an inclusive range. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Small stable non-negative string hash (deterministic across runs). */
function hash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
