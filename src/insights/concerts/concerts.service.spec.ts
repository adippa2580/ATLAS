import { ConcertsService } from './concerts.module';

/**
 * Concerts invariants: we join the venue room's artist affinities to the events
 * feed, rank by guests-interested then soonest date, cap the external fan-out,
 * and degrade to an empty slate when a feed returns nothing.
 */
describe('ConcertsService', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  /** A feed where only 'Keinemusik' has a dated show; everything else is []. */
  function makeFeed() {
    return {
      eventsByArtist: jest.fn(async (name: string) =>
        name === 'Keinemusik'
          ? [
              {
                sourceId: 'e1',
                name: 'Keinemusik @ Club',
                date: '2026-08-01T22:00:00Z',
                genres: [],
                city: 'Miami',
                venueName: 'Club X',
              },
            ]
          : [],
      ),
    };
  }

  /**
   * Minimal prisma double. `affinities` are GuestAffinity rows; the guest query
   * echoes back whichever cohort ids it is handed (consent gate assumed passed
   * unless overridden), and bookings drive the cohort.
   */
  function makePrisma(opts: {
    venue?: any;
    bookings?: { guestId: string }[];
    consentedIds?: string[] | null; // null => echo the cohort
    affinities?: any[];
  }) {
    return {
      venue: {
        findFirst: async () =>
          opts.venue === undefined ? { id: 'v1', city: 'Miami' } : opts.venue,
      },
      booking: {
        findMany: async () => opts.bookings ?? [],
      },
      guest: {
        findMany: async ({ where }: any) => {
          const ids: string[] = where.id?.in ?? [];
          const allow =
            opts.consentedIds === undefined || opts.consentedIds === null
              ? ids
              : opts.consentedIds;
          return ids.filter((id) => allow.includes(id)).map((id) => ({ id }));
        },
      },
      guestAffinity: {
        findMany: async ({ where }: any) => {
          const all = opts.affinities ?? [];
          const ids = where?.guestId?.in;
          // Honour the tenant/consent-scoped guestId filter so the cohort gate
          // is actually exercised (the service only reads consented guests).
          return ids ? all.filter((a: any) => ids.includes(a.guestId)) : all;
        },
      },
    };
  }

  it('joins artist affinities to events and ranks by guestsInterested + date', async () => {
    const prisma = makePrisma({
      bookings: [{ guestId: 'g1' }, { guestId: 'g2' }],
      // Keinemusik: 2 interested guests; Other: 1 guest (feed returns [] for it).
      affinities: [
        { guestId: 'g1', subjectRef: 'Keinemusik', score: 0.9 },
        { guestId: 'g2', subjectRef: 'Keinemusik', score: 0.8 },
        { guestId: 'g1', subjectRef: 'Other Artist', score: 0.7 },
      ],
    });
    const feed = makeFeed();
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx, 'v1');

    expect(out.venueId).toBe('v1');
    expect(out.city).toBe('Miami');
    // Two distinct artists were queried against the feed.
    expect(out.scanned).toBe(2);
    // Only Keinemusik produced an event.
    expect(out.artistsConsidered).toBe(1);
    expect(out.concerts).toHaveLength(1);
    const top = out.concerts[0];
    expect(top.artist).toBe('Keinemusik');
    expect(top.event).toBe('Keinemusik @ Club');
    expect(top.guestsInterested).toBe(2);
    expect(top.venue).toBe('Club X');
    expect(top.date).toBe('2026-08-01T22:00:00Z');
  });

  it('sorts concerts by soonest date across artists', async () => {
    const feed = {
      eventsByArtist: jest.fn(async (name: string) => {
        if (name === 'Later')
          return [
            {
              sourceId: 'l1',
              name: 'Later Show',
              date: '2026-09-10T22:00:00Z',
              genres: [],
              city: 'Miami',
              venueName: 'V2',
            },
          ];
        if (name === 'Sooner')
          return [
            {
              sourceId: 's1',
              name: 'Sooner Show',
              date: '2026-08-05T22:00:00Z',
              genres: [],
              city: 'Miami',
              venueName: 'V1',
            },
          ];
        return [];
      }),
    };
    const prisma = makePrisma({
      bookings: [{ guestId: 'g1' }, { guestId: 'g2' }, { guestId: 'g3' }],
      affinities: [
        // 'Later' has more interested guests but a later date.
        { guestId: 'g1', subjectRef: 'Later', score: 0.9 },
        { guestId: 'g2', subjectRef: 'Later', score: 0.9 },
        { guestId: 'g3', subjectRef: 'Sooner', score: 0.9 },
      ],
    });
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx, 'v1');
    expect(out.concerts.map((c) => c.event)).toEqual([
      'Sooner Show',
      'Later Show',
    ]);
  });

  it('returns an empty slate when the cohort is empty', async () => {
    const prisma = makePrisma({ bookings: [] });
    const feed = makeFeed();
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx, 'v1');
    expect(out.artistsConsidered).toBe(0);
    expect(out.concerts).toEqual([]);
    expect(out.scanned).toBe(0);
    expect(feed.eventsByArtist).not.toHaveBeenCalled();
  });

  it('returns nulls when the tenant has no venue', async () => {
    const prisma = makePrisma({ venue: null });
    const feed = makeFeed();
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx);
    expect(out.venueId).toBeNull();
    expect(out.city).toBeNull();
    expect(out.artistsConsidered).toBe(0);
    expect(out.concerts).toEqual([]);
  });

  it('caps the external fan-out at the top 12 artists', async () => {
    // 20 artists, each with a distinct guest so ranking is well-defined.
    const affinities = Array.from({ length: 20 }, (_, i) => ({
      guestId: `g${i}`,
      subjectRef: `Artist ${String(i).padStart(2, '0')}`,
      score: 1 - i / 100, // strictly descending so the top 12 are deterministic
    }));
    const bookings = affinities.map((a) => ({ guestId: a.guestId }));
    const prisma = makePrisma({ bookings, affinities });
    const feed = makeFeed(); // every artist returns [] here
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx, 'v1');
    expect(out.scanned).toBe(12);
    expect(feed.eventsByArtist).toHaveBeenCalledTimes(12);
  });

  it('is resilient when a feed returns [] (no throw, empty concerts)', async () => {
    const prisma = makePrisma({
      bookings: [{ guestId: 'g1' }],
      affinities: [{ guestId: 'g1', subjectRef: 'Nobody Playing', score: 0.5 }],
    });
    const feed = makeFeed(); // returns [] for 'Nobody Playing'
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx, 'v1');
    expect(out.scanned).toBe(1);
    expect(out.artistsConsidered).toBe(0);
    expect(out.concerts).toEqual([]);
  });

  it('drops guests that fail the consent/provisional gate from the cohort', async () => {
    const prisma = makePrisma({
      bookings: [{ guestId: 'g1' }, { guestId: 'g2' }],
      consentedIds: ['g1'], // only g1 clears the gate
      affinities: [
        { guestId: 'g1', subjectRef: 'Keinemusik', score: 0.9 },
        { guestId: 'g2', subjectRef: 'Keinemusik', score: 0.9 },
      ],
    });
    const feed = makeFeed();
    const svc = new ConcertsService(prisma as any, feed as any);

    const out = await svc.concerts(ctx, 'v1');
    // Even though two guests booked, only g1 is consented, so guestsInterested = 1.
    expect(out.concerts[0].artist).toBe('Keinemusik');
    expect(out.concerts[0].guestsInterested).toBe(1);
  });
});
