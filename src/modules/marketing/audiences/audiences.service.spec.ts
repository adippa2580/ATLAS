import { AudiencesService } from './audiences.module';
import { REACHABLE_CONSENT_SCOPES } from './taste-segments.module';

/**
 * Audience reach is a consent-gated discovery send: only guests with a live
 * reachable grant are resolved, the audience is persisted, and delivery goes
 * through the stub-first Klaviyo rail. Never a blast.
 */
describe('AudiencesService.reach', () => {
  const ctx: any = { tenantId: 't1', scopes: [] };

  function make(overrides: any = {}) {
    const prisma: any = {
      guestAffinity: {
        findMany: jest.fn(async () => [
          { guestId: 'g1' },
          { guestId: 'g1' },
          { guestId: 'g2' },
        ]),
      },
      guest: {
        findMany: jest.fn(async () => [
          {
            id: 'g1',
            email: 'a@x.io',
            primaryPhone: null,
            displayName: 'Ada',
          },
        ]),
      },
      audience: {
        create: jest.fn(async () => ({ id: 'aud-1' })),
      },
      ...overrides.prisma,
    };
    const klaviyo: any = {
      sendCampaign: jest.fn(async (n: number) => ({
        delivered: n,
        provider: 'klaviyo',
        stub: true,
      })),
    };
    return { svc: new AudiencesService(prisma, klaviyo), prisma, klaviyo };
  }

  it('resolves affinity-matched guests, gated on a live reachable consent', async () => {
    const { svc, prisma } = make();
    await svc.reach(ctx, { subjectRef: 'afro house', minScore: 1 });

    // Affinity predicate applied, mute-respecting.
    expect(prisma.guestAffinity.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 't1',
          muted: false,
          subjectRef: 'afro house',
          score: { gte: 1 },
        }),
      }),
    );
    // Consent gate present on the guest resolution.
    const guestWhere = prisma.guest.findMany.mock.calls[0][0].where;
    expect(guestWhere.id).toEqual({ in: ['g1', 'g2'] });
    expect(guestWhere.consents).toEqual({
      some: { revokedAt: null, scope: { in: REACHABLE_CONSENT_SCOPES } },
    });
  });

  it('persists the audience and hands recipients to the Klaviyo rail', async () => {
    const { svc, klaviyo, prisma } = make();
    const out = await svc.reach(ctx, { minScore: 1 });

    expect(prisma.audience.create).toHaveBeenCalled();
    // audienceSize + a recipient list derived from the consented guests.
    expect(klaviyo.sendCampaign).toHaveBeenCalledWith(
      1,
      expect.objectContaining({
        template: 'lifecycle_campaign',
        audienceId: 'aud-1',
      }),
      [expect.objectContaining({ externalId: 'g1', email: 'a@x.io' })],
    );
    expect(out).toEqual({
      audienceId: 'aud-1',
      count: 1,
      delivery: { delivered: 1, provider: 'klaviyo', stub: true },
    });
  });

  it('never contacts anyone when no consented guest matches', async () => {
    const { svc, klaviyo } = make({
      prisma: { guest: { findMany: jest.fn(async () => []) } },
    });
    const out = await svc.reach(ctx, { minScore: 1 });
    expect(out.count).toBe(0);
    // sendCampaign still called with size 0 + empty list (adapter reports 0).
    expect(klaviyo.sendCampaign).toHaveBeenCalledWith(
      0,
      expect.any(Object),
      [],
    );
  });
});
