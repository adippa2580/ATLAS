import { CrewBlendService } from './crew-blend.service';
import { SubjectType } from '@prisma/client';

/**
 * Unit test for the load-bearing crew-blend invariants (W2 §6): mute-union,
 * consensus boost, and confidence — without a database.
 */
describe('CrewBlendService (blend invariants)', () => {
  function makeService(affinities: any[], members: any[]) {
    const captured: any[] = [];
    const prisma: any = {
      // Crew is tenant-scoped: recompute validates the crew belongs to the tenant.
      crew: { findUnique: async () => ({ id: 'crew1', tenantId: 't1' }) },
      crewMember: { findMany: async () => members },
      guestAffinity: { findMany: async () => affinities },
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
});
