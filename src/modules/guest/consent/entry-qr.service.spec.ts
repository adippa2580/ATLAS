import { EntryQrService } from './entry-qr.module';

/**
 * Entry-QR consent capture — extending walk-in door capture to every venue.
 * A scan is an opt-in, so a captured contact yields a non-provisional guest
 * with a VERIFIED identity link, an explicit consent grant, and a consent-
 * tagged venue `attend` signal. A repeat scan on the same day is a no-op.
 */
describe('EntryQrService.scan', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make(overrides: any = {}) {
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
        findFirst: jest.fn(async () => null),
        update: jest.fn(async ({ data }: any) => ({ id: 'gX', ...data })),
      },
      identityLink: { findFirst: jest.fn(async () => null) },
      affinityEvidence: { findUnique: jest.fn(async () => null) },
      consentGrant: {
        create: jest.fn(async () => ({ id: 'c1' })),
      },
      ...overrides,
    };
    return {
      svc: new EntryQrService(prisma, bus, identity),
      prisma,
      identity,
      bus,
    };
  }

  it('enriches a consented scan: non-provisional guest, verified link, consent grant, consent-tagged attend evidence', async () => {
    const { svc, identity, bus } = make();
    const res: any = await svc.scan(ctx, {
      venueId: 'v1',
      phone: '+13105550123',
      displayName: 'Ada',
    });

    // Non-provisional guest created (the scan is the opt-in).
    expect(identity.create).toHaveBeenCalledWith(
      ctx,
      expect.objectContaining({ provisional: false }),
    );
    expect(res.guest.provisional).toBe(false);

    // Verified identity link, sourced to entry-qr.
    expect(identity.addLink).toHaveBeenCalledWith(
      ctx,
      'gNew',
      expect.objectContaining({
        kind: 'phone',
        verified: true,
        source: 'entry-qr',
      }),
    );
    expect(res.linksAdded).toBe(1);

    // Consent grant returned.
    expect(res.consentId).toBe('c1');

    // Consent-tagged venue attend evidence.
    expect(bus.publish).toHaveBeenCalledTimes(1);
    const msg = bus.publish.mock.calls[0][0];
    expect(msg.signal).toBe('attend');
    expect(msg.subjectType).toBe('venue');
    expect(msg.subjectRef).toBe('v1');
    expect(msg.consentId).toBe('c1');
  });

  it('defaults scope to identity and records an explicit entry-qr consent', async () => {
    const { svc, prisma } = make();
    await svc.scan(ctx, { venueId: 'v1', email: 'ada@x.io' });

    expect(prisma.consentGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          scope: 'identity',
          basis: 'explicit',
          connector: 'entry-qr',
        }),
      }),
    );
  });

  it('honours an explicit scope', async () => {
    const { svc, prisma } = make();
    await svc.scan(ctx, { venueId: 'v1', phone: '+1310', scope: 'marketing' });
    expect(prisma.consentGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ scope: 'marketing' }),
      }),
    );
  });

  it('is idempotent: a matching same-day scan returns the prior guest + consent, no new writes', async () => {
    const { svc, prisma, identity, bus } = make({
      affinityEvidence: {
        findUnique: jest.fn(async () => ({
          guestId: 'gPrior',
          consentId: 'cPrior',
        })),
      },
      guest: {
        findFirst: jest.fn(async () => ({ id: 'gPrior', provisional: false })),
        update: jest.fn(),
      },
    });

    const res: any = await svc.scan(ctx, {
      venueId: 'v1',
      phone: '+13105550123',
    });

    expect(res.guest.id).toBe('gPrior');
    expect(res.consentId).toBe('cPrior');
    expect(res.linksAdded).toBe(0);
    expect(identity.create).not.toHaveBeenCalled();
    expect(identity.addLink).not.toHaveBeenCalled();
    expect(prisma.consentGrant.create).not.toHaveBeenCalled();
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it('resolves an existing guest by verified identity link and promotes a provisional record', async () => {
    const { svc, prisma, identity } = make({
      identityLink: {
        findFirst: jest.fn(async () => ({ guestId: 'gOld' })),
      },
      guest: {
        findFirst: jest.fn(async () => ({
          id: 'gOld',
          provisional: true,
          primaryPhone: null,
          email: null,
          displayName: null,
        })),
        update: jest.fn(async ({ data }: any) => ({ id: 'gOld', ...data })),
      },
    });

    const res: any = await svc.scan(ctx, {
      venueId: 'v1',
      phone: '+13105550123',
    });

    expect(identity.create).not.toHaveBeenCalled();
    expect(prisma.guest.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'gOld' },
        data: expect.objectContaining({ provisional: false }),
      }),
    );
    expect(res.guest.provisional).toBe(false);
    expect(identity.addLink).toHaveBeenCalled();
  });
});
