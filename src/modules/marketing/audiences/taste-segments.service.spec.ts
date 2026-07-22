import { TasteSegmentsService } from './taste-segments.module';

/**
 * Taste-segments: addressable audiences built from the taste graph. Reachability
 * = non-provisional guest + active marketing/identity ConsentGrant, mirroring
 * revenue-insights identityCoverage. Muted affinities never target.
 *
 * Hand-rolled Prisma stub (style: ops/closeout.service.spec.ts): each guest's
 * addressability is decided by the `where` we pass to guest.findMany, so the
 * stub applies that filter itself against a fixed fixture.
 */
describe('TasteSegmentsService', () => {
  // Guests: g1/g2/g3 addressable; g4 provisional; g5 consent revoked.
  const guests = [
    {
      id: 'g1',
      displayName: 'Ada',
      provisional: false,
      consents: [{ revokedAt: null, scope: 'marketing' }],
    },
    {
      id: 'g2',
      displayName: 'Ben',
      provisional: false,
      consents: [{ revokedAt: null, scope: 'identity' }],
    },
    {
      id: 'g3',
      displayName: 'Cy',
      provisional: false,
      consents: [{ revokedAt: null, scope: 'marketing' }],
    },
    {
      id: 'g4',
      displayName: 'Dee',
      provisional: true, // provisional → not addressable
      consents: [{ revokedAt: null, scope: 'marketing' }],
    },
    {
      id: 'g5',
      displayName: 'Eve',
      provisional: false,
      consents: [{ revokedAt: new Date(), scope: 'marketing' }], // revoked → not addressable
    },
  ];

  // Strongest non-muted subject per guest (score-desc order overall):
  //   g1 techno .9, g2 techno .8, g3 house .7, g4 techno .95 (provisional),
  //   g5 techno .85 (revoked), g1 house .3 (weaker, ignored as g1 already placed),
  //   g6 techno .6 muted (excluded entirely).
  const affinities = [
    {
      guestId: 'g4',
      subjectType: 'genre',
      subjectRef: 'techno',
      score: 0.95,
      muted: false,
    },
    {
      guestId: 'g1',
      subjectType: 'genre',
      subjectRef: 'techno',
      score: 0.9,
      muted: false,
    },
    {
      guestId: 'g5',
      subjectType: 'genre',
      subjectRef: 'techno',
      score: 0.85,
      muted: false,
    },
    {
      guestId: 'g2',
      subjectType: 'genre',
      subjectRef: 'techno',
      score: 0.8,
      muted: false,
    },
    {
      guestId: 'g3',
      subjectType: 'genre',
      subjectRef: 'house',
      score: 0.7,
      muted: false,
    },
    {
      guestId: 'g6',
      subjectType: 'genre',
      subjectRef: 'techno',
      score: 0.6,
      muted: true,
    },
    {
      guestId: 'g1',
      subjectType: 'genre',
      subjectRef: 'house',
      score: 0.3,
      muted: false,
    },
  ];

  function makeSvc(over?: { affinities?: any[]; entities?: any[] }) {
    const prisma: any = {
      guest: {
        findMany: async ({ where }: any) => {
          const scopes: string[] = where.consents.some.scope.in;
          return guests
            .filter((g) => {
              if (where.provisional === false && g.provisional) return false;
              const ok = g.consents.some(
                (c) => c.revokedAt === null && scopes.includes(c.scope),
              );
              return ok;
            })
            .map((g) => ({ id: g.id, displayName: g.displayName }));
        },
      },
      guestAffinity: {
        findMany: async ({ where, orderBy }: any) => {
          let rows = (over?.affinities ?? affinities).filter(
            (a) =>
              a.subjectType === where.subjectType &&
              a.muted === where.muted &&
              a.score >= (where.score?.gte ?? 0),
          );
          if (orderBy?.score === 'desc')
            rows = [...rows].sort((a, b) => b.score - a.score);
          return rows.map((a) => ({
            guestId: a.guestId,
            subjectRef: a.subjectRef,
            score: a.score,
          }));
        },
      },
      entity: {
        findMany: async ({ where }: any) =>
          (over?.entities ?? []).filter((e) => where.id.in.includes(e.id)),
      },
    };
    return new TasteSegmentsService(prisma);
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('clusters addressable guests by their strongest genre affinity', async () => {
    const res = await makeSvc().segments(ctx, {});
    const techno = res.segments.find((s) => s.subjectRef === 'techno')!;
    const house = res.segments.find((s) => s.subjectRef === 'house')!;

    // techno reaches g1 + g2 only (g4 provisional, g5 revoked excluded).
    expect(techno.reachableGuests).toBe(2);
    expect(techno.sampleGuests.map((g) => g.guestId).sort()).toEqual([
      'g1',
      'g2',
    ]);
    // g1's strongest is techno(.9); its weaker house(.3) must NOT create a member.
    expect(house.reachableGuests).toBe(1);
    expect(house.sampleGuests[0].guestId).toBe('g3');
    // avgScore is the mean of member strongest-scores.
    expect(techno.avgScore).toBeCloseTo((0.9 + 0.8) / 2);
  });

  it('excludes provisional and consent-revoked guests from reach', async () => {
    const res = await makeSvc().segments(ctx, {});
    const all = res.segments.flatMap((s) =>
      s.sampleGuests.map((g) => g.guestId),
    );
    expect(all).not.toContain('g4'); // provisional
    expect(all).not.toContain('g5'); // consent revoked
    expect(all).not.toContain('g6'); // muted affinity, never targeted
  });

  it('sorts segments by reachable guests descending', async () => {
    const res = await makeSvc().segments(ctx, {});
    const reach = res.segments.map((s) => s.reachableGuests);
    expect(reach).toEqual([...reach].sort((a, b) => b - a));
    expect(res.segments[0].subjectRef).toBe('techno'); // biggest reach first
  });

  it('resolves artist subjectRefs to catalog names; genres stay raw', async () => {
    const artistAff = [
      {
        guestId: 'g1',
        subjectType: 'artist',
        subjectRef: 'ent-1',
        score: 0.9,
        muted: false,
      },
      {
        guestId: 'g2',
        subjectType: 'artist',
        subjectRef: 'ent-1',
        score: 0.8,
        muted: false,
      },
      {
        guestId: 'g3',
        subjectType: 'artist',
        subjectRef: 'ent-2',
        score: 0.7,
        muted: false,
      },
    ];
    const svc = makeSvc({
      affinities: artistAff,
      entities: [{ id: 'ent-1', name: 'Peggy Gou' }],
    });
    const res = await svc.segments(ctx, { subjectType: 'artist' as any });
    const top = res.segments.find((s) => s.subjectRef === 'ent-1')!;
    expect(top.segmentName).toBe('Peggy Gou');
    // unresolved artist ref falls back to the raw id.
    const other = res.segments.find((s) => s.subjectRef === 'ent-2')!;
    expect(other.segmentName).toBe('ent-2');
  });

  it('applies the minScore floor', async () => {
    const res = await makeSvc().segments(ctx, { minScore: 0.85 });
    // Only g1(.9) survives among addressable guests at >= .85.
    const techno = res.segments.find((s) => s.subjectRef === 'techno')!;
    expect(techno.reachableGuests).toBe(1);
    expect(techno.sampleGuests[0].guestId).toBe('g1');
  });
});
