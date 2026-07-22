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
 */
@Injectable()
export class EventsFeedAdapter {
  private readonly logger = new Logger(EventsFeedAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('connectors.ticketmasterApiKey') ?? '';
  }

  private get stub(): boolean {
    return !this.apiKey;
  }

  private nextDow(dow: number, hour = 22): string {
    const d = new Date();
    d.setDate(d.getDate() + ((((dow - d.getDay()) % 7) + 7) % 7) || 7);
    d.setHours(hour, 0, 0, 0);
    return d.toISOString();
  }

  async fetchCity(city: string): Promise<FeedResult> {
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
}
