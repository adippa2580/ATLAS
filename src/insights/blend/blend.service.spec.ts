import { BlendService } from './blend.module';

/**
 * Blend invariants: consensus-boost ordering matches CrewBlendService, mutes are
 * a hard union, the venue cohort is gated on consent + enriched identity (via
 * the mocked queries), guest-blend is a Jaccard overlap with either-side mute
 * exclusion, and crew-blend only surfaces what CrewBlendService already stored.
 */
describe('BlendService', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  // --- fixture-driven prisma double (plain async methods, no jest module mocks) ---
  function make(opts: {
    venue?: any;
    recentBookings?: any[]; // booking.findMany -> [{ guestId }]
    cohort?: any[]; // guest.findMany -> [{ id }] (already consent/provisional filtered)
    guestAffinities?: any[]; // guestAffinity.findMany rows
    crewAffinities?: any[]; // crewAffinity.findMany rows
  }) {
    const prisma: any = {
      venue: {
        findFirst: async () => opts.venue ?? { id: 'v1', tenantId: 't1' },
      },
      booking: {
        findMany: async () => opts.recentBookings ?? [],
      },
      guest: {
        findMany: async () => opts.cohort ?? [],
      },
      guestAffinity: {
        findMany: async () => opts.guestAffinities ?? [],
      },
      crewAffinity: {
        findMany: async () => opts.crewAffinities ?? [],
      },
    };
    return new BlendService(prisma as any);
  }

  const aff = (
    guestId: string,
    subjectType: string,
    subjectRef: string,
    score: number,
    muted = false,
  ) => ({ guestId, subjectType, subjectRef, score, muted });

  // -------------------------------------------------------------------------
  // Venue crowd-blend
  // -------------------------------------------------------------------------
  describe('venueBlend', () => {
    it('orders artists/genres by consensus-boost and shapes the summary', async () => {
      const svc = make({
        venue: { id: 'v1' },
        recentBookings: [{ guestId: 'g1' }, { guestId: 'g2' }],
        cohort: [{ id: 'g1' }, { id: 'g2' }],
        guestAffinities: [
          // shared artist (count 2) beats a solo artist even at equal sum-per-head
          aff('g1', 'artist', 'drake', 0.6),
          aff('g2', 'artist', 'drake', 0.6),
          aff('g1', 'artist', 'sza', 0.9),
          // genres
          aff('g1', 'genre', 'house', 0.8),
          aff('g2', 'genre', 'house', 0.8),
          aff('g2', 'genre', 'techno', 0.5),
        ],
      });

      const out: any = await svc.venueBlend(ctx, 'v1', 30);
      expect(out.guests).toBe(2);
      // drake: (1.2/2)*(1+2/2)=1.2 ; sza: (0.9/2)*(1+1/2)=0.675 -> drake first
      expect(out.topArtists[0].ref).toBe('drake');
      expect(out.topArtists[0].score).toBe(1.2);
      expect(out.topArtists[0].confidence).toBe(1);
      expect(out.topArtists[1].ref).toBe('sza');
      // house is the consensus genre, techno solo
      expect(out.topGenres[0].ref).toBe('house');
      expect(out.summary).toContain('house');
      expect(out.summary).toContain('drake');
    });

    it('excludes any subject muted by a single cohort member (hard union)', async () => {
      const svc = make({
        recentBookings: [{ guestId: 'g1' }, { guestId: 'g2' }],
        cohort: [{ id: 'g1' }, { id: 'g2' }],
        guestAffinities: [
          aff('g1', 'artist', 'drake', 0.9),
          aff('g2', 'artist', 'drake', 0.9, true), // g2 mutes drake -> vetoed
          aff('g1', 'artist', 'sza', 0.7),
        ],
      });

      const out: any = await svc.venueBlend(ctx, 'v1', 30);
      const refs = out.topArtists.map((r: any) => r.ref);
      expect(refs).not.toContain('drake');
      expect(refs).toContain('sza');
    });

    it('returns an empty-cohort message when consent/provisional filtering drops everyone', async () => {
      // recent bookings exist, but the guest query (consent + provisional gate) yields none
      const svc = make({
        recentBookings: [{ guestId: 'g1' }],
        cohort: [],
      });
      const out: any = await svc.venueBlend(ctx, 'v1', 14);
      expect(out.guests).toBe(0);
      expect(out.topArtists).toEqual([]);
      expect(out.summary).toContain('14 days');
    });

    it('resolves the tenant first venue when venueId is omitted', async () => {
      const svc = make({
        venue: { id: 'v-first' },
        recentBookings: [],
        cohort: [],
      });
      const out: any = await svc.venueBlend(ctx, undefined, undefined);
      expect(out.venueId).toBe('v-first');
      expect(out.windowDays).toBe(30); // default window
    });
  });

  // -------------------------------------------------------------------------
  // Guest-to-guest blend
  // -------------------------------------------------------------------------
  describe('guestBlend', () => {
    it('computes overlap, blendScore and combined (min) scores', async () => {
      const svc = make({
        guestAffinities: [
          // shared: drake (artist), house (genre)
          aff('a', 'artist', 'drake', 0.9),
          aff('b', 'artist', 'drake', 0.4),
          aff('a', 'genre', 'house', 0.8),
          aff('b', 'genre', 'house', 0.7),
          // a-only and b-only -> union grows
          aff('a', 'artist', 'sza', 0.5),
          aff('b', 'genre', 'techno', 0.6),
        ],
      });

      const out: any = await svc.guestBlend(ctx, 'a', 'b');
      expect(out.sharedCount).toBe(2);
      // union = {drake, house, sza, techno} = 4 -> 100*2/4 = 50
      expect(out.blendScore).toBe(50);
      expect(out.topSharedArtists).toEqual([
        { ref: 'drake', combinedScore: 0.4 },
      ]);
      expect(out.topSharedGenres).toEqual([
        { ref: 'house', combinedScore: 0.7 },
      ]);
    });

    it('excludes subjects muted by either side from both shared and union', async () => {
      const svc = make({
        guestAffinities: [
          aff('a', 'artist', 'drake', 0.9),
          aff('b', 'artist', 'drake', 0.8, true), // b mutes drake -> dropped entirely
          aff('a', 'genre', 'house', 0.6),
          aff('b', 'genre', 'house', 0.6),
        ],
      });

      const out: any = await svc.guestBlend(ctx, 'a', 'b');
      // drake gone from both sides; only house remains -> union 1, shared 1
      expect(out.sharedCount).toBe(1);
      expect(out.blendScore).toBe(100);
      expect(out.topSharedArtists).toEqual([]);
      expect(out.topSharedGenres[0].ref).toBe('house');
    });

    it('returns a clear message when there is no overlap', async () => {
      const svc = make({
        guestAffinities: [
          aff('a', 'artist', 'drake', 0.9),
          aff('b', 'artist', 'sza', 0.9),
        ],
      });
      const out: any = await svc.guestBlend(ctx, 'a', 'b');
      expect(out.sharedCount).toBe(0);
      expect(out.blendScore).toBe(0);
      expect(out.message).toMatch(/no overlap/i);
    });
  });

  // -------------------------------------------------------------------------
  // Crew blend (surface-only)
  // -------------------------------------------------------------------------
  describe('crewBlend', () => {
    it('surfaces stored artists/genres and nudges the top artist as bookHint', async () => {
      const svc = make({
        crewAffinities: [
          {
            subjectType: 'artist',
            subjectRef: 'drake',
            blendedScore: 1.4,
            confidence: 0.9,
          },
          {
            subjectType: 'genre',
            subjectRef: 'house',
            blendedScore: 1.1,
            confidence: 0.8,
          },
        ],
      });
      const out: any = await svc.crewBlend(ctx, 'c1');
      expect(out.topArtists[0]).toEqual({
        ref: 'drake',
        score: 1.4,
        confidence: 0.9,
      });
      expect(out.topGenres[0].ref).toBe('house');
      expect(out.bookHint).toContain('drake');
    });

    it('falls back to the top genre for bookHint when no artist blend exists', async () => {
      const svc = make({
        crewAffinities: [
          {
            subjectType: 'genre',
            subjectRef: 'techno',
            blendedScore: 0.9,
            confidence: 0.7,
          },
        ],
      });
      const out: any = await svc.crewBlend(ctx, 'c1');
      expect(out.topArtists).toEqual([]);
      expect(out.bookHint).toContain('techno');
    });

    it('reports an empty blend when the crew has none computed yet', async () => {
      const svc = make({ crewAffinities: [] });
      const out: any = await svc.crewBlend(ctx, 'c1');
      expect(out.bookHint).toBeNull();
      expect(out.message).toMatch(/no computed blend/i);
    });
  });
});
