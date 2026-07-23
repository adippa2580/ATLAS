import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface FeedEvent {
  sourceId: string;
  name: string;
  date: string; // ISO
  genres: string[];
  city: string;
  venueName?: string;
}

export interface FeedVenue {
  sourceId: string;
  name: string;
  city: string;
}

export interface FeedResult {
  source: string;
  city: string;
  events: FeedEvent[];
  venues: FeedVenue[];
  stub: boolean;
}

/**
 * Public events feed adapter (Ticketmaster Discovery shape) — the class-3
 * catalog ingest source. Populates the shared entity catalog (events, venues)
 * so recommendations always have named, dated things to ground against.
 *
 * STUB mode when TICKETMASTER_API_KEY is unset: returns a deterministic,
 * *dated* slate (next Fri/Sat relative to now) so the ingest → recommend →
 * act loop is exercisable without credentials — same philosophy as every
 * other connector in the platform.
 *
 * Class-3 rule (plan §3.1): this data is entity/catalog-level only. It never
 * touches guest-level records and needs no consent. Competitor flagging is
 * NOT done here — a feed cannot know who competes with you; that stays a
 * curated judgement via POST /v1/catalog/competitors.
 *
 * Source priority:
 *   1. ALIST partner feed (ALIST_FEED_URL + ALIST_FEED_KEY) — the A-List
 *      Supabase `ra_events` table, itself refreshed from Resident Advisor +
 *      Ticketmaster by A-List's ra-cron. Public-read by policy
 *      (ra_events_public_read); the key is the publishable anon key. This is
 *      the plan's "A-List as first ingest point", catalog-grade.
 *   2. Ticketmaster Discovery directly (TICKETMASTER_API_KEY).
 *   3. Deterministic stub slate (no credentials).
 */
@Injectable()
export class EventsFeedAdapter {
  private readonly logger = new Logger(EventsFeedAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('connectors.ticketmasterApiKey') ?? '';
  }

  private get bandsintownAppId(): string {
    return this.config.get<string>('connectors.bandsintownAppId') ?? '';
  }

  private get alistUrl(): string {
    return this.config.get<string>('connectors.alistFeedUrl') ?? '';
  }

  private get alistKey(): string {
    return this.config.get<string>('connectors.alistFeedKey') ?? '';
  }

  private get stub(): boolean {
    return !this.apiKey && !(this.alistUrl && this.alistKey);
  }

  /** City name → A-List ra_events city_slug (ra-cron's slug set). */
  private citySlug(city: string): string {
    const key = city.trim().toLowerCase().replace(/\s+/g, '');
    const known: Record<string, string> = {
      miami: 'us/miami',
      newyork: 'us/newyork',
      losangeles: 'us/losangeles',
      chicago: 'us/chicago',
      houston: 'us/houston',
      detroit: 'us/detroit',
      dallas: 'us/dallas',
      lasvegas: 'us/lasvegas',
      london: 'uk/london',
      berlin: 'de/berlin',
      amsterdam: 'nl/amsterdam',
      barcelona: 'es/barcelona',
      paris: 'fr/paris',
      ibiza: 'es/ibiza',
      toronto: 'ca/toronto',
      montreal: 'ca/montreal',
      sydney: 'au/sydney',
      melbourne: 'au/melbourne',
      tokyo: 'jp/tokyo',
    };
    return known[key] ?? `us/${key}`;
  }

  /** ALIST partner feed: read upcoming rows from the public ra_events table. */
  private async fetchAlist(city: string): Promise<FeedResult> {
    const slug = this.citySlug(city);
    const nowIso = new Date().toISOString();
    const url =
      `${this.alistUrl}/rest/v1/ra_events` +
      `?city_slug=eq.${encodeURIComponent(slug)}` +
      `&start_time=gte.${encodeURIComponent(nowIso)}` +
      '&order=start_time.asc&limit=100';
    const res = await fetch(url, {
      headers: {
        apikey: this.alistKey,
        Authorization: `Bearer ${this.alistKey}`,
      },
    });
    if (!res.ok) {
      throw new Error(`alist feed ${res.status} for ${city}`);
    }
    const rows: any[] = await res.json();
    const events: FeedEvent[] = [];
    const venuesByName = new Map<string, FeedVenue>();
    for (const r of rows) {
      if (!r?.ra_event_id || !r?.title || !r?.start_time) continue;
      const genres = [
        ...new Set(
          (Array.isArray(r.genres) ? r.genres : [])
            .map((g: any) =>
              typeof g === 'string'
                ? g
                : typeof g?.name === 'string'
                  ? g.name
                  : null,
            )
            .filter((g: any): g is string => !!g)
            .map((g: string) => g.toLowerCase()),
        ),
      ] as string[];
      events.push({
        sourceId: String(r.ra_event_id),
        name: r.title,
        date: r.start_time,
        genres,
        city,
        venueName: r.venue_name ?? undefined,
      });
      if (r.venue_name && !venuesByName.has(r.venue_name)) {
        venuesByName.set(r.venue_name, {
          sourceId: `alist:${slug}:${r.venue_name}`,
          name: r.venue_name,
          city,
        });
      }
    }
    return {
      source: 'alist-ra',
      city,
      stub: false,
      events,
      venues: [...venuesByName.values()],
    };
  }

  private nextDow(dow: number, hour = 22): string {
    const d = new Date();
    d.setDate(d.getDate() + ((((dow - d.getDay()) % 7) + 7) % 7) || 7);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }

  async fetchCity(city: string): Promise<FeedResult> {
    if (this.alistUrl && this.alistKey) {
      return this.fetchAlist(city);
    }
    if (this.stub) {
      this.logger.debug(`[eventsfeed-stub] slate for ${city}`);
      return {
        source: 'ticketmaster',
        city,
        stub: true,
        events: [
          {
            sourceId: 'tm-ev-001',
            name: 'Sundown Festival — After Parties',
            date: this.nextDow(6),
            genres: ['afro house', 'amapiano'],
            city,
            venueName: 'Sundown Grounds',
          },
          {
            sourceId: 'tm-ev-002',
            name: 'Warehouse Series: Keinemusik',
            date: this.nextDow(5),
            genres: ['afro house', 'deep house'],
            city,
            venueName: 'The Works',
          },
          {
            sourceId: 'tm-ev-003',
            name: 'Amapiano Rooftop Sessions',
            date: this.nextDow(0, 18),
            genres: ['amapiano'],
            city,
            venueName: 'Rival Rooftop',
          },
        ],
        venues: [
          { sourceId: 'tm-vn-001', name: 'Rival Rooftop', city },
          { sourceId: 'tm-vn-002', name: 'The Works', city },
        ],
      };
    }

    // Live: Ticketmaster Discovery API v2 (music events for the city).
    const url =
      'https://app.ticketmaster.com/discovery/v2/events.json' +
      `?apikey=${encodeURIComponent(this.apiKey)}` +
      `&city=${encodeURIComponent(city)}` +
      '&classificationName=music&size=50&sort=date,asc';
    const res = await fetch(url);
    if (!res.ok) {
      throw new Error(`events feed ${res.status} for ${city}`);
    }
    const body: any = await res.json();
    const raw: any[] = body?._embedded?.events ?? [];
    const events: FeedEvent[] = [];
    const venuesByRef = new Map<string, FeedVenue>();
    for (const e of raw) {
      const date: string | undefined =
        e?.dates?.start?.dateTime ??
        (e?.dates?.start?.localDate
          ? `${e.dates.start.localDate}T22:00:00Z`
          : undefined);
      if (!e?.id || !e?.name || !date) continue; // undated events cannot ground
      const genres = [
        ...new Set(
          (e?.classifications ?? [])
            .flatMap((c: any) => [c?.genre?.name, c?.subGenre?.name])
            .filter((g: any) => typeof g === 'string' && g !== 'Undefined')
            .map((g: string) => g.toLowerCase()),
        ),
      ] as string[];
      const venue = e?._embedded?.venues?.[0];
      events.push({
        sourceId: e.id,
        name: e.name,
        date,
        genres,
        city,
        venueName: venue?.name,
      });
      if (venue?.id && venue?.name) {
        venuesByRef.set(venue.id, {
          sourceId: venue.id,
          name: venue.name,
          city,
        });
      }
    }
    return {
      source: 'ticketmaster',
      city,
      stub: false,
      events,
      venues: [...venuesByRef.values()],
    };
  }

  /**
   * Upcoming events for a specific artist — the join behind "artists your guests
   * follow are playing near this venue". Queries every configured source and
   * merges them: Ticketmaster (attraction → events, arena/major coverage) +
   * Bandsintown (artist-first, the club/indie/international long tail). Results
   * are deduped by day + venue and returned soonest-first. STUB mode (no source
   * configured) returns one deterministic dated show so the loop is exercisable.
   *
   * Returns [] on no match or a feed hiccup — a missing artist is not an error.
   */
  async eventsByArtist(
    artist: string,
    opts: { city?: string; size?: number } = {},
  ): Promise<FeedEvent[]> {
    const name = artist.trim();
    if (!name) return [];

    const hasTM = !!this.apiKey;
    const hasBIT = !!this.bandsintownAppId;
    if (!hasTM && !hasBIT) {
      return [
        {
          sourceId: `stub:${name}`,
          name: `${name} (live)`,
          date: this.nextDow(6),
          genres: [],
          city: opts.city ?? 'Miami',
          venueName: 'Ticketmaster stub venue',
        },
      ];
    }

    const [tm, bit] = await Promise.all([
      hasTM ? this.artistEventsTicketmaster(name, opts) : Promise.resolve([]),
      hasBIT ? this.artistEventsBandsintown(name, opts) : Promise.resolve([]),
    ]);

    // Merge + dedupe by (day, venue) — the same show can appear in both feeds.
    // Ticketmaster first so its ticketed listing wins a tie.
    const seen = new Set<string>();
    const merged: FeedEvent[] = [];
    for (const e of [...tm, ...bit].sort((a, b) =>
      a.date.localeCompare(b.date),
    )) {
      const key = `${e.date.slice(0, 10)}|${(e.venueName ?? '').toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(e);
    }
    return merged.slice(0, opts.size ?? 5);
  }

  /** Ticketmaster attraction → events. */
  private async artistEventsTicketmaster(
    name: string,
    opts: { city?: string; size?: number },
  ): Promise<FeedEvent[]> {
    try {
      const aUrl =
        'https://app.ticketmaster.com/discovery/v2/attractions.json' +
        `?apikey=${encodeURIComponent(this.apiKey)}` +
        `&keyword=${encodeURIComponent(name)}` +
        '&classificationName=music&size=1&sort=relevance,desc';
      const aRes = await fetch(aUrl);
      if (!aRes.ok) return [];
      const aBody = (await aRes.json()) as {
        _embedded?: { attractions?: { id?: string }[] };
      };
      const attractionId = aBody._embedded?.attractions?.[0]?.id;
      if (!attractionId) return [];

      const eUrl =
        'https://app.ticketmaster.com/discovery/v2/events.json' +
        `?apikey=${encodeURIComponent(this.apiKey)}` +
        `&attractionId=${encodeURIComponent(attractionId)}` +
        (opts.city ? `&city=${encodeURIComponent(opts.city)}` : '') +
        `&size=${opts.size ?? 5}&sort=date,asc`;
      const eRes = await fetch(eUrl);
      if (!eRes.ok) return [];
      const eBody = (await eRes.json()) as {
        _embedded?: { events?: Record<string, unknown>[] };
      };
      const raw = eBody._embedded?.events ?? [];
      const out: FeedEvent[] = [];
      for (const e of raw as any[]) {
        const date: string | undefined =
          e?.dates?.start?.dateTime ??
          (e?.dates?.start?.localDate
            ? `${e.dates.start.localDate}T22:00:00Z`
            : undefined);
        if (!e?.id || !e?.name || !date) continue;
        const venue = e?._embedded?.venues?.[0];
        out.push({
          sourceId: e.id,
          name: e.name,
          date,
          genres: [],
          city: venue?.city?.name ?? opts.city ?? '',
          venueName: venue?.name,
        });
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `[eventsfeed] ticketmaster eventsByArtist(${name}) failed: ${(err as Error).message}`,
      );
      return [];
    }
  }

  /**
   * Bandsintown artist-events — GET /artists/{name}/events. Returns all upcoming
   * shows for the artist; we geo-narrow to the venue city (lenient substring
   * match to survive "New York" vs "New York City"). Unknown artist → non-array
   * body → [].
   */
  private async artistEventsBandsintown(
    name: string,
    opts: { city?: string; size?: number },
  ): Promise<FeedEvent[]> {
    try {
      const url =
        `https://rest.bandsintown.com/artists/${encodeURIComponent(name)}/events` +
        `?app_id=${encodeURIComponent(this.bandsintownAppId)}&date=upcoming`;
      const res = await fetch(url, { headers: { accept: 'application/json' } });
      if (!res.ok) return [];
      const body = (await res.json()) as unknown;
      if (!Array.isArray(body)) return [];
      const wanted = opts.city?.trim().toLowerCase();
      const out: FeedEvent[] = [];
      for (const e of body as any[]) {
        const raw: string | undefined = e?.datetime;
        const venue = e?.venue;
        if (!e?.id || !raw || !venue) continue;
        const city: string = venue.city ?? '';
        if (
          wanted &&
          city &&
          !city.toLowerCase().includes(wanted) &&
          !wanted.includes(city.toLowerCase())
        ) {
          continue;
        }
        // Bandsintown datetimes are local + tz-naive ("2026-08-15T20:00:00").
        const date = /[Z+]/.test(raw) ? raw : `${raw}Z`;
        out.push({
          sourceId: `bit:${e.id}`,
          name: e.title || `${name} at ${venue.name ?? city}`,
          date,
          genres: [],
          city,
          venueName: venue.name,
        });
      }
      return out;
    } catch (err) {
      this.logger.warn(
        `[eventsfeed] bandsintown eventsByArtist(${name}) failed: ${(err as Error).message}`,
      );
      return [];
    }
  }
}
