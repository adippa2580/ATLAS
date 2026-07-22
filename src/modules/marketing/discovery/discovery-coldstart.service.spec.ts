import {
  DiscoveryService,
  COLDSTART_AFFINITY_THRESHOLD,
} from './discovery.module';

/**
 * Cold-start crew blend (W2): a guest with rich personal taste ranks on their
 * own affinity ('personal'); a cold guest (below COLDSTART_AFFINITY_THRESHOLD)
 * who belongs to a crew is seeded from the blended crew affinity of that crew
 * ('crew-blend-coldstart'), so a brand-new guest still gets a warm ranked list.
 */
describe('DiscoveryService cold-start crew blend', () => {
  function make(opts: {
    guestAffinity?: any[];
    crewMember?: any[];
    crewAffinity?: any[];
    entity?: any[];
  }) {
    const prisma: any = {
      guestAffinity: {
        findMany: async () => opts.guestAffinity ?? [],
      },
      crewMember: {
        findMany: async () => opts.crewMember ?? [],
      },
      crewAffinity: {
        findMany: async () => opts.crewAffinity ?? [],
      },
      entity: {
        findMany: async ({ where }: any) =>
          (opts.entity ?? []).filter((e) => where.id.in.includes(e.id)),
      },
    };
    return new DiscoveryService(prisma);
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('ranks on personal affinity when the guest has enough of their own taste', async () => {
    const guestAffinity = [
      { subjectType: 'artist', subjectRef: 'a1', score: 9, muted: false },
      { subjectType: 'venue', subjectRef: 'v1', score: 7, muted: false },
      { subjectType: 'genre', subjectRef: 'g1', score: 5, muted: false },
      { subjectType: 'artist', subjectRef: 'a2', score: 3, muted: false },
    ];
    const svc = make({
      guestAffinity,
      entity: [{ id: 'a1', kind: 'artist', name: 'Peggy Gou' }],
      // A crew blend exists but MUST be ignored for a warm guest.
      crewMember: [{ crewId: 'c1' }],
      crewAffinity: [
        {
          subjectType: 'venue',
          subjectRef: 'vX',
          blendedScore: 99,
          confidence: 1,
        },
      ],
    });

    const res = await svc.recommendations(ctx, 'guest-warm');

    expect(res.source).toBe('personal');
    expect(res.items).toHaveLength(4);
    expect(res.items[0].subjectRef).toBe('a1');
    expect(res.items[0].score).toBe(9);
    expect(res.items[0].entity).toEqual({
      id: 'a1',
      kind: 'artist',
      name: 'Peggy Gou',
    });
    // None of the crew-only subjects leaked in.
    expect(res.items.map((i: any) => i.subjectRef)).not.toContain('vX');
  });

  it('falls back to the blended crew affinity for a cold guest in a crew', async () => {
    // Cold: fewer personal rows than the threshold.
    const guestAffinity = [
      { subjectType: 'artist', subjectRef: 'a1', score: 4, muted: false },
    ];
    expect(guestAffinity.length).toBeLessThan(COLDSTART_AFFINITY_THRESHOLD);

    const svc = make({
      guestAffinity,
      crewMember: [{ crewId: 'c1' }, { crewId: 'c2' }],
      // Subject v1 surfaces in both crews → its blended score sums (6 + 4 = 10)
      // and outranks e1 (which only appears once at 8).
      crewAffinity: [
        {
          subjectType: 'venue',
          subjectRef: 'v1',
          blendedScore: 6,
          confidence: 0.5,
        },
        {
          subjectType: 'event',
          subjectRef: 'e1',
          blendedScore: 8,
          confidence: 0.9,
        },
        {
          subjectType: 'venue',
          subjectRef: 'v1',
          blendedScore: 4,
          confidence: 0.8,
        },
      ],
      entity: [{ id: 'v1', kind: 'venue', name: 'Berghain' }],
    });

    const res = await svc.recommendations(ctx, 'guest-cold');

    expect(res.source).toBe('crew-blend-coldstart');
    // Crew-derived subjects present, personal subject not surfaced.
    const refs = res.items.map((i: any) => i.subjectRef);
    expect(refs).toEqual(['v1', 'e1']);
    // v1 blended across the two crews and kept the strongest confidence.
    expect(res.items[0].subjectRef).toBe('v1');
    expect(res.items[0].score).toBe(10);
    expect((res.items[0] as any).confidence).toBe(0.8);
    expect(res.items[0].entity).toEqual({
      id: 'v1',
      kind: 'venue',
      name: 'Berghain',
    });
  });

  it('stays on the personal path when a cold guest has no crew to fall back to', async () => {
    const res = await make({
      guestAffinity: [
        { subjectType: 'artist', subjectRef: 'a1', score: 4, muted: false },
      ],
      crewMember: [],
    }).recommendations(ctx, 'guest-cold-no-crew');

    expect(res.source).toBe('personal');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].subjectRef).toBe('a1');
  });
});
