import { CrewBlendService } from './crew-blend.service';
import { SubjectType } from '@prisma/client';

/**
 * Unit test for the load-bearing crew-blend invariants (W2 §6): mute-union,
 * consensus boost, and confidence — without a database.
 */
describe('CrewBlendService (blend invariants)', () => {
  function makeService(
    affinities: any[],
    members: any[],
    opts: { paid?: any[]; history?: any[] } = {},
  ) {
    const captured: any[] = [];
    const prisma: any = {
      // Crew is tenant-scoped: recompute validates the crew belongs to the tenant.
      crew: { findUnique: async () => ({ id: 'crew1', tenantId: 't1' }) },
      crewMember: { findMany: async () => members },
      guestAffinity: { findMany: async () => affinities },
      affinityEvidence: { findMany: async () => opts.paid ?? [] },
      booking: { groupBy: async () => opts.history ?? [] },
      crewAffinity: {
        deleteMany: () => ({ __op: 'delete' }),
        createMany: (arg: any) => {
          captured.push(...arg.data);
          return { __op: 'create' };
        },
      },
      $transaction: async (ops: any[]) => ops,
    };
    const svc = new CrewBlendService(prisma);
    return { svc, captured };
  }

  const ctx = { tenantId: 't1', scopes: [] };

  it('excludes any subject muted by a member (hard union)', async () => {
    const members = [{ guestId: 'a' }, { guestId: 'b' }];
    const affinities = [
      {
        guestId: 'a',
        subjectType: SubjectType.artist,
        subjectRef: 'X',
        score: 5,
        muted: false,
      },
      {
        guestId: 'b',
        subjectType: SubjectType.artist,
        subjectRef: 'X',
        score: 4,
        muted: true,
      },
      {
        guestId: 'a',
        subjectType: SubjectType.artist,
        subjectRef: 'Y',
        score: 3,
        muted: false,
      },
    ];
    const { svc, captured } = makeService(affinities, members);
    await svc.recompute(ctx as any, 'crew1');
    const refs = captured.map((r) => r.subjectRef);
    expect(refs).toContain('Y');
    expect(refs).not.toContain('X'); // muted by member b
    // Every persisted crew-affinity row carries the tenant (P0-2 scoping).
    expect(captured.every((r) => r.tenantId === 't1')).toBe(true);
  });

  it('rejects a crew that belongs to another tenant', async () => {
    const prisma: any = {
      crew: { findUnique: async () => ({ id: 'crew1', tenantId: 'other' }) },
      crewMember: { findMany: async () => [] },
      guestAffinity: { findMany: async () => [] },
      affinityEvidence: { findMany: async () => [] },
      booking: { groupBy: async () => [] },
      crewAffinity: { deleteMany: () => ({}), createMany: () => ({}) },
      $transaction: async (ops: any[]) => ops,
    };
    const svc = new CrewBlendService(prisma);
    await expect(svc.recompute(ctx as any, 'crew1')).rejects.toThrow();
  });

  it('boosts subjects shared across the crew above solo subjects', async () => {
    const members = [{ guestId: 'a' }, { guestId: 'b' }];
    const affinities = [
      {
        guestId: 'a',
        subjectType: SubjectType.genre,
        subjectRef: 'shared',
        score: 4,
        muted: false,
      },
      {
        guestId: 'b',
        subjectType: SubjectType.genre,
        subjectRef: 'shared',
        score: 4,
        muted: false,
      },
      {
        guestId: 'a',
        subjectType: SubjectType.genre,
        subjectRef: 'solo',
        score: 4,
        muted: false,
      },
    ];
    const { svc, captured } = makeService(affinities, members);
    await svc.recompute(ctx as any, 'crew1');
    const shared = captured.find((r) => r.subjectRef === 'shared');
    const solo = captured.find((r) => r.subjectRef === 'solo');
    expect(shared.blendedScore).toBeGreaterThan(solo.blendedScore);
    expect(shared.confidence).toBeGreaterThan(solo.confidence);
  });

  it('up-weights booking-backed member contributions (invariant 5)', async () => {
    const members = [{ guestId: 'a' }, { guestId: 'b' }];
    const affinities = [
      {
        guestId: 'a',
        subjectType: SubjectType.genre,
        subjectRef: 'paid',
        score: 4,
        muted: false,
      },
      {
        guestId: 'b',
        subjectType: SubjectType.genre,
        subjectRef: 'browsed',
        score: 4,
        muted: false,
      },
    ];
    const { svc, captured } = makeService(affinities, members, {
      paid: [
        { guestId: 'a', subjectType: SubjectType.genre, subjectRef: 'paid' },
      ],
    });
    await svc.recompute(ctx as any, 'crew1');
    const paid = captured.find((r) => r.subjectRef === 'paid');
    const browsed = captured.find((r) => r.subjectRef === 'browsed');
    expect(paid.blendedScore).toBeGreaterThan(browsed.blendedScore);
  });

  it('adds the crew-history posterior on top of the composed prior (invariant 6)', async () => {
    const members = [{ guestId: 'a' }];
    const affinities = [
      {
        guestId: 'a',
        subjectType: SubjectType.venue,
        subjectRef: 'v1',
        score: 2,
        muted: false,
      },
    ];
    const { svc, captured } = makeService(affinities, members, {
      history: [{ venueId: 'v1', _count: { _all: 2 } }],
    });
    await svc.recompute(ctx as any, 'crew1');
    const v1 = captured.find((r) => r.subjectRef === 'v1');
    // composed (2/1)*(1+1)=4 + history 3*2=6 → 10; history dominates prior.
    expect(v1.blendedScore).toBe(10);
    expect(v1.confidence).toBe(1);
  });

  it('creates a crew affinity from history alone, but a mute still vetoes', async () => {
    const members = [{ guestId: 'a' }];
    const affinities = [
      {
        guestId: 'a',
        subjectType: SubjectType.venue,
        subjectRef: 'vMuted',
        score: 5,
        muted: true,
      },
    ];
    const { svc, captured } = makeService(affinities, members, {
      history: [
        { venueId: 'vNew', _count: { _all: 1 } },
        { venueId: 'vMuted', _count: { _all: 4 } },
      ],
    });
    await svc.recompute(ctx as any, 'crew1');
    const refs = captured.map((r) => r.subjectRef);
    expect(refs).toContain('vNew'); // history-only venue gets a row
    expect(refs).not.toContain('vMuted'); // mute vetoes even realised history
  });
});
