import { DoorService } from './door.module';

/**
 * Door walk-in capture — turning an un-enriched arrival into a consented,
 * enriched guest. An anonymous walk-in stays provisional; a walk-in that hands
 * over contact + opt-in is promoted (verified link + consent grant), which is
 * what lifts the identity pillar's coverage.
 */
describe('DoorService.walkIn', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make() {
    const created: any = {};
    const identity: any = {
      create: jest.fn(async (_c: any, dto: any) => ({
        id: 'gNew',
        provisional: dto.provisional,
        primaryPhone: dto.primaryPhone ?? null,
        email: dto.email ?? null,
        displayName: dto.displayName ?? null,
      })),
      addLink: jest.fn(async () => ({})),
      ensureGlobalGuest: jest.fn(async () => 'spine1'),
    };
    const bus: any = { publish: jest.fn(async () => {}) };
    const prisma: any = {
      guest: {
        findFirst: async () => null,
        update: jest.fn(async ({ data }: any) => ({ id: 'gX', ...data })),
      },
      identityLink: { findFirst: async () => null },
      consentGrant: {
        create: jest.fn(async () => {
          created.consent = true;
          return { id: 'c1' };
        }),
      },
      booking: { findUnique: async () => null },
      $transaction: async (fn: any) =>
        fn({
          booking: {
            create: async ({ data }: any) => ({ id: 'bNew', ...data }),
          },
          bookingStatusEvent: { create: async () => ({}) },
        }),
    };
    return { svc: new DoorService(prisma, bus, identity), identity, bus };
  }

  it('seats an anonymous walk-in as a provisional guest and publishes attend evidence', async () => {
    const { svc, identity, bus } = make();
    const res: any = await svc.walkIn(ctx, { venueId: 'v1', partySize: 3 });

    expect(identity.create).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ provisional: true }),
    );
    expect(identity.addLink).not.toHaveBeenCalled();
    expect(res.enriched).toBe(false);
    expect(res.booking.status).toBe('seated');
    expect(res.booking.partySize).toBe(3);

    expect(bus.publish).toHaveBeenCalledTimes(1);
    const msg = bus.publish.mock.calls[0][0];
    expect(msg.signal).toBe('attend');
    expect(msg.consentId).toBeUndefined();
  });

  it('enriches a consented walk-in: verified link, consent grant, consent-tagged evidence', async () => {
    const { svc, identity, bus } = make();
    const res: any = await svc.walkIn(ctx, {
      venueId: 'v1',
      phone: '+13105550123',
      displayName: 'Ada',
      consent: true,
    });

    expect(identity.create).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ provisional: false }),
    );
    expect(identity.addLink).toHaveBeenCalledWith(
      ctx,
      'gNew',
      expect.objectContaining({
        kind: 'phone',
        verified: true,
        source: 'door',
      }),
    );
    expect(res.enriched).toBe(true);

    const msg = bus.publish.mock.calls[0][0];
    expect(msg.consentId).toBe('c1');
  });

  it('is idempotent: a matching prior walk-in is returned, not duplicated', async () => {
    const bus: any = { publish: jest.fn(async () => {}) };
    const prisma: any = {
      guest: { findFirst: async () => null },
      identityLink: { findFirst: async () => null },
      booking: {
        findUnique: async () => ({ id: 'existing', status: 'seated' }),
      },
    };
    const identity: any = {
      create: jest.fn(async () => ({ id: 'gNew', provisional: true })),
      addLink: jest.fn(async () => ({})),
      ensureGlobalGuest: jest.fn(),
    };
    const res: any = await new DoorService(prisma, bus, identity).walkIn(ctx, {
      venueId: 'v1',
      idempotencyKey: 'dup-key',
    });
    expect(res.booking.id).toBe('existing');
    expect(bus.publish).not.toHaveBeenCalled();
  });
});
