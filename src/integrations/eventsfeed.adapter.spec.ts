import { EventsFeedAdapter } from './eventsfeed.adapter';

/** ALIST partner-feed source: slug mapping, row normalisation, date gating. */
describe('EventsFeedAdapter (alist source)', () => {
  const soon = new Date(Date.now() + 2 * 86_400_000).toISOString();

  function make(rows: any[]) {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.alistFeedUrl'
          ? 'https://alist.example'
          : k === 'connectors.alistFeedKey'
            ? 'anon-key'
            : undefined,
    };
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      calls.push(String(url));
      return { ok: true, json: async () => rows } as any;
    }) as any;
    return { adapter: new EventsFeedAdapter(config), calls };
  }

  it('queries the ra_events table with the city slug and maps rows', async () => {
    const { adapter, calls } = make([
      {
        ra_event_id: 'tm_ABC',
        title: 'Club Space: Keinemusik',
        start_time: soon,
        venue_name: 'Club Space',
        genres: [{ name: 'Afro House' }, 'Amapiano'],
      },
      { ra_event_id: 'bad', title: null, start_time: soon }, // dropped: no title
    ]);
    const res = await adapter.fetchCity('Miami');
    expect(calls[0]).toContain('city_slug=eq.us%2Fmiami');
    expect(calls[0]).toContain('start_time=gte.');
    expect(res.source).toBe('alist-ra');
    expect(res.stub).toBe(false);
    expect(res.events).toHaveLength(1);
    expect(res.events[0].genres).toEqual(['afro house', 'amapiano']);
    expect(res.venues[0]).toMatchObject({ name: 'Club Space' });
  });

  it('maps known cities to ra-cron slugs and unknowns to us/<key>', async () => {
    const { adapter, calls } = make([]);
    await adapter.fetchCity('Las Vegas');
    expect(calls[0]).toContain('city_slug=eq.us%2Flasvegas');
    await adapter.fetchCity('Sydney');
    expect(calls[1]).toContain('city_slug=eq.au%2Fsydney');
    await adapter.fetchCity('Austin');
    expect(calls[2]).toContain('city_slug=eq.us%2Faustin');
  });

  it('surfaces feed errors instead of silently falling back', async () => {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.alistFeedUrl'
          ? 'https://alist.example'
          : k === 'connectors.alistFeedKey'
            ? 'anon-key'
            : undefined,
    };
    global.fetch = jest.fn(async () => ({ ok: false, status: 500 })) as any;
    const adapter = new EventsFeedAdapter(config);
    await expect(adapter.fetchCity('Miami')).rejects.toThrow('alist feed 500');
  });
});

/** eventsByArtist: the artist → attraction → events join (concerts). */
describe('EventsFeedAdapter.eventsByArtist', () => {
  const realFetch = global.fetch;
  afterEach(() => {
    global.fetch = realFetch;
  });

  it('stub mode (no key) returns one deterministic dated show', async () => {
    const config: any = { get: () => undefined };
    const adapter = new EventsFeedAdapter(config);
    const out = await adapter.eventsByArtist('Keinemusik', { city: 'Miami' });
    expect(out).toHaveLength(1);
    expect(out[0].name).toContain('Keinemusik');
    expect(out[0].city).toBe('Miami');
    expect(new Date(out[0].date).getTime()).toBeGreaterThan(0);
  });

  it('live: resolves an attraction then lists its events', async () => {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.ticketmasterApiKey' ? 'tm-key' : undefined,
    };
    const calls: string[] = [];
    global.fetch = jest.fn(async (url: any) => {
      calls.push(String(url));
      if (String(url).includes('/attractions.json')) {
        return {
          ok: true,
          json: async () => ({ _embedded: { attractions: [{ id: 'K123' }] } }),
        } as any;
      }
      return {
        ok: true,
        json: async () => ({
          _embedded: {
            events: [
              {
                id: 'ev1',
                name: 'Keinemusik — Miami',
                dates: { start: { dateTime: '2026-08-15T22:00:00Z' } },
                _embedded: {
                  venues: [{ name: 'Factory Town', city: { name: 'Miami' } }],
                },
              },
            ],
          },
        }),
      } as any;
    }) as any;

    const adapter = new EventsFeedAdapter(config);
    const out = await adapter.eventsByArtist('Keinemusik', { city: 'Miami' });
    expect(calls[0]).toContain('/attractions.json');
    expect(calls[1]).toContain('attractionId=K123');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourceId: 'ev1',
      name: 'Keinemusik — Miami',
      venueName: 'Factory Town',
      city: 'Miami',
    });
  });

  it('live: returns [] when the artist has no attraction match', async () => {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.ticketmasterApiKey' ? 'tm-key' : undefined,
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ _embedded: {} }),
    })) as any;
    const adapter = new EventsFeedAdapter(config);
    expect(await adapter.eventsByArtist('Nobody')).toEqual([]);
  });

  it('Bandsintown-only: maps artist events and geo-narrows to the venue city', async () => {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.bandsintownAppId' ? 'bit-app' : undefined,
    };
    let calledUrl = '';
    global.fetch = jest.fn(async (url: any) => {
      calledUrl = String(url);
      return {
        ok: true,
        json: async () => [
          {
            id: 'b1',
            title: 'ANOTR — NYC',
            datetime: '2026-08-20T20:00:00',
            venue: { name: 'Brooklyn Mirage', city: 'New York' },
          },
          {
            id: 'b2',
            title: 'ANOTR — Berlin',
            datetime: '2026-08-25T22:00:00',
            venue: { name: 'Berghain', city: 'Berlin' },
          },
        ],
      } as any;
    }) as any;

    const adapter = new EventsFeedAdapter(config);
    const out = await adapter.eventsByArtist('ANOTR', {
      city: 'New York City',
    });
    expect(calledUrl).toContain('rest.bandsintown.com/artists/ANOTR/events');
    expect(calledUrl).toContain('app_id=bit-app');
    // Only the New York show survives the city filter ("New York" ⊂ "New York City").
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      sourceId: 'bit:b1',
      venueName: 'Brooklyn Mirage',
      city: 'New York',
    });
    // tz-naive datetime normalised to ISO (Z appended).
    expect(out[0].date).toBe('2026-08-20T20:00:00Z');
  });

  it('merges Ticketmaster + Bandsintown and dedupes the same day+venue', async () => {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.ticketmasterApiKey'
          ? 'tm-key'
          : k === 'connectors.bandsintownAppId'
            ? 'bit-app'
            : undefined,
    };
    global.fetch = jest.fn(async (url: any) => {
      const u = String(url);
      if (u.includes('/attractions.json')) {
        return {
          ok: true,
          json: async () => ({ _embedded: { attractions: [{ id: 'K1' }] } }),
        } as any;
      }
      if (u.includes('/events.json')) {
        return {
          ok: true,
          json: async () => ({
            _embedded: {
              events: [
                {
                  id: 'tm1',
                  name: 'Keinemusik — Miami',
                  dates: { start: { dateTime: '2026-08-15T22:00:00Z' } },
                  _embedded: {
                    venues: [{ name: 'Factory Town', city: { name: 'Miami' } }],
                  },
                },
              ],
            },
          }),
        } as any;
      }
      // Bandsintown: one duplicate (same day+venue as TM) + one unique later show.
      return {
        ok: true,
        json: async () => [
          {
            id: 'dup',
            title: 'Keinemusik at Factory Town',
            datetime: '2026-08-15T22:00:00',
            venue: { name: 'Factory Town', city: 'Miami' },
          },
          {
            id: 'uniq',
            title: 'Keinemusik — Wynwood',
            datetime: '2026-09-01T22:00:00',
            venue: { name: 'Wynwood Warehouse', city: 'Miami' },
          },
        ],
      } as any;
    }) as any;

    const adapter = new EventsFeedAdapter(config);
    const out = await adapter.eventsByArtist('Keinemusik', { city: 'Miami' });
    // The duplicate collapses; TM's ticketed listing wins the tie.
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      sourceId: 'tm1',
      venueName: 'Factory Town',
    });
    expect(out[1]).toMatchObject({
      sourceId: 'bit:uniq',
      venueName: 'Wynwood Warehouse',
    });
  });

  it('Bandsintown unknown artist (non-array body) → []', async () => {
    const config: any = {
      get: (k: string) =>
        k === 'connectors.bandsintownAppId' ? 'bit-app' : undefined,
    };
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ message: 'Artist not found' }),
    })) as any;
    const adapter = new EventsFeedAdapter(config);
    expect(await adapter.eventsByArtist('Nobody')).toEqual([]);
  });
});
