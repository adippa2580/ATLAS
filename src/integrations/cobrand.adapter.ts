import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ArtistIntel } from './connector.types';

/**
 * Co:Brand adapter — emerging-culture & social-sound intelligence.
 *
 * Co:Brand tracks artists on the rise: below the mainstream streaming threshold
 * but accelerating on social + short-form audio (the "social sound" that breaks
 * before radio does). It surfaces who is emerging in a given market, with
 * genres, top audience markets, streaming momentum and a computed audience-fit
 * blend — the early signal a venue wants before an artist becomes expensive.
 *
 * ATLAS mapping: each row becomes intelligence on an Entity(kind=artist) —
 * momentum/genres/markets land on Entity.metadata, and a rising artist raises an
 * early-booking signal for the discovery layer (book the culture before the
 * mainstream re-prices it). fitScore + topMarkets are compared against the
 * venue's own audience so the signal is discovery, never a blast.
 *
 * STUB mode when connectors.cobrandApiKey is unset — returns a deterministic
 * sample set so onboarding + emerging-culture insights work without a key,
 * mirroring the other stub-first connectors. Read-only: no webhook.
 *
 * Built for KAN-5.
 */
@Injectable()
export class CobrandAdapter {
  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.cobrandApiKey');
  }

  /**
   * Fetch emerging/rising artists for a market as artist intelligence. Stubbed
   * deterministically; live mode is intentionally unimplemented in this build.
   */
  async fetchEmerging(market?: string): Promise<ArtistIntel[]> {
    if (this.stub) {
      const rows: ArtistIntel[] = [
        {
          externalArtistId: 'cb_art_201',
          name: 'Sofia Kourtesis',
          genres: ['organic house', 'electronica'],
          monthlyListeners: 420000,
          followers: 85000,
          momentum: 0.72,
          topMarkets: ['Berlin', 'London', 'Sydney'],
          fitScore: 0.81,
          emerging: true,
        },
        {
          externalArtistId: 'cb_art_202',
          name: 'Sammy Virji',
          genres: ['uk garage', 'bassline'],
          monthlyListeners: 610000,
          followers: 140000,
          momentum: 0.64,
          topMarkets: ['London', 'Manchester', 'Melbourne'],
          fitScore: 0.76,
          emerging: true,
        },
        {
          externalArtistId: 'cb_art_203',
          name: 'Nia Archives',
          genres: ['jungle', 'drum and bass'],
          monthlyListeners: 540000,
          followers: 210000,
          momentum: 0.58,
          topMarkets: ['London', 'Bristol', 'Brisbane'],
          fitScore: 0.79,
          emerging: true,
        },
        {
          externalArtistId: 'cb_art_204',
          name: 'Lonely C',
          genres: ['house', 'disco'],
          monthlyListeners: 180000,
          followers: 46000,
          momentum: 0.41,
          topMarkets: ['New York', 'Sydney', 'Amsterdam'],
          fitScore: 0.68,
          emerging: true,
        },
      ];
      if (market) {
        const m = market.toLowerCase();
        const filtered = rows.filter((r) =>
          (r.topMarkets ?? []).some((t) => t.toLowerCase() === m),
        );
        // Fall back to the full set if the market matches nothing, so callers
        // always get a usable, deterministic sample.
        return filtered.length > 0 ? filtered : rows;
      }
      return rows;
    }
    throw new Error('Co:Brand live mode not configured in this build');
  }

  /**
   * Normalise a raw Co:Brand artist object into the shared ArtistIntel.
   * Defensive on field-name variants (id/artist_id, name, genres,
   * monthly_listeners/monthlyListeners, momentum/trend, markets/top_markets,
   * fit/fitScore). momentum is clamped to −1..1, fitScore to 0..1, and
   * `emerging` defaults to true for this connector when the vendor doesn't say.
   */
  normalizeArtist(body: any): ArtistIntel {
    const name: string =
      body?.name ?? body?.artist_name ?? body?.title ?? 'Unknown artist';

    const rawGenres: unknown = body?.genres ?? body?.genre ?? body?.tags;
    const genres: string[] | undefined = Array.isArray(rawGenres)
      ? rawGenres.map((g): string => String(g))
      : typeof rawGenres === 'string'
        ? [rawGenres]
        : undefined;

    const rawMarkets: unknown =
      body?.topMarkets ?? body?.top_markets ?? body?.markets;
    const topMarkets: string[] | undefined = Array.isArray(rawMarkets)
      ? rawMarkets.map((m): string => String(m))
      : typeof rawMarkets === 'string'
        ? [rawMarkets]
        : undefined;

    const monthlyRaw = body?.monthly_listeners ?? body?.monthlyListeners;
    const monthlyListeners: number | undefined =
      monthlyRaw === undefined || monthlyRaw === null
        ? undefined
        : this.finiteOrUndefined(Number(monthlyRaw));

    const followersRaw = body?.followers ?? body?.follower_count;
    const followers: number | undefined =
      followersRaw === undefined || followersRaw === null
        ? undefined
        : this.finiteOrUndefined(Number(followersRaw));

    const momentumRaw = body?.momentum ?? body?.trend;
    const momentum: number | undefined =
      momentumRaw === undefined || momentumRaw === null
        ? undefined
        : this.clamp(Number(momentumRaw), -1, 1);

    const fitRaw = body?.fitScore ?? body?.fit;
    const fitScore: number | undefined =
      fitRaw === undefined || fitRaw === null
        ? undefined
        : this.clamp(Number(fitRaw), 0, 1);

    const emerging: boolean =
      typeof body?.emerging === 'boolean' ? body.emerging : true;

    return {
      externalArtistId: String(body?.id ?? body?.artist_id ?? 'cb_art_stub'),
      name,
      genres,
      monthlyListeners,
      followers,
      momentum,
      topMarkets,
      fitScore,
      emerging,
    };
  }

  /** Clamp a possibly non-finite number into [min, max]; NaN → min. */
  private clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  private finiteOrUndefined(value: number): number | undefined {
    return Number.isFinite(value) ? value : undefined;
  }
}
