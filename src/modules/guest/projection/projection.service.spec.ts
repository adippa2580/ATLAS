import { ForbiddenException } from '@nestjs/common';
import { SubjectType } from '@prisma/client';
import { ProjectionService } from './projection.module';

/**
 * Unit test for the load-bearing projection invariant: cross-tenant affinity is
 * disclosed ONLY behind a live consent grant, and even then only as a derived
 * summary that leaks no foreign guestIds or tenant identifiers.
 */
describe('ProjectionService (consent-gated cross-tenant projection)', () => {
  const ctx = { tenantId: 'venueTenant', scopes: [] } as any;

  // A guest in the CALLER's tenant, already on the spine 'spine1'.
  const callerGuest = { id: 'g-caller', globalGuestId: 'spine1' };

  // The spine spans the caller's own guest plus a foreign-tenant guest.
  const spineGuests = [{ id: 'g-caller' }, { id: 'g-foreign' }];

  // Affinity rows across both tenants, incl. a muted row that must be excluded.
  const affinities = [
    {
      guestId: 'g-caller',
      subjectType: SubjectType.genre,
      subjectRef: 'techno',
      score: 3,
      muted: false,
    },
    {
      guestId: 'g-foreign',
      subjectType: SubjectType.genre,
      subjectRef: 'techno',
      score: 4,
      muted: false,
    },
    {
      guestId: 'g-foreign',
      subjectType: SubjectType.artist,
      subjectRef: 'X',
      score: 9,
      muted: true, // hard-muted: must never surface
    },
    {
      guestId: 'g-caller',
      subjectType: SubjectType.artist,
      subjectRef: 'Y',
      score: 2,
      muted: false,
    },
  ];

  function makeService(grant: any) {
    const prisma: any = {
      guest: {
        findFirst: async () => callerGuest,
        findMany: async () => spineGuests,
      },
      venueProjectionGrant: {
        // The service filters revokedAt:null, so a revoked grant surfaces as
        // "no row". Emulate that by returning the grant only when it's live.
        findFirst: async ({ where }: any) =>
          grant && grant.revokedAt === null && where.revokedAt === null
            ? grant
            : null,
      },
      guestAffinity: {
        // Mimic the muted:false filter the service applies.
        findMany: async ({ where }: any) =>
          where.muted === false
            ? affinities.filter((a) => !a.muted)
            : affinities,
      },
    };
    return new ProjectionService(prisma);
  }

  it('returns a top-affinity summary for a valid non-revoked grant and leaks no ids', async () => {
    const svc = makeService({
      id: 'grant1',
      scope: 'affinity:summary',
      globalGuestId: 'spine1',
      granteeTenantId: 'venueTenant',
      revokedAt: null,
    });

    const result = await svc.project(ctx, 'g-caller');

    // Cross-tenant aggregation: techno = 3 (caller) + 4 (foreign) = 7, ranked first.
    expect(result.top[0]).toEqual({
      subjectType: 'genre',
      subjectRef: 'techno',
      score: 7,
    });
    // Muted artist X is excluded entirely.
    expect(result.top.some((t) => t.subjectRef === 'X')).toBe(false);
    // Solo caller affinity still present.
    expect(result.top.some((t) => t.subjectRef === 'Y')).toBe(true);
    // Two profiles contributed (a count, not identities).
    expect(result.contributingProfiles).toBe(2);
    // Only the caller's OWN guest id is echoed.
    expect(result.guestId).toBe('g-caller');

    // No foreign guestId or tenant identifier anywhere in the payload.
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('g-foreign');
    expect(serialized).not.toContain('venueTenant');
    expect(serialized).not.toContain('spine1');
    // Disclosed shape is only {subjectType, subjectRef, score} — no guestId key.
    for (const t of result.top) {
      expect(Object.keys(t).sort()).toEqual([
        'score',
        'subjectRef',
        'subjectType',
      ]);
    }
  });

  it('throws Forbidden when no grant exists', async () => {
    const svc = makeService(null);
    await expect(svc.project(ctx, 'g-caller')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('throws Forbidden when the grant is revoked', async () => {
    const svc = makeService({
      id: 'grant1',
      scope: 'affinity:summary',
      globalGuestId: 'spine1',
      granteeTenantId: 'venueTenant',
      revokedAt: new Date(), // revoked → filtered out by revokedAt:null
    });
    await expect(svc.project(ctx, 'g-caller')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
