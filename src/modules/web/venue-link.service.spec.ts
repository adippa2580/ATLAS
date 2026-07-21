import { NotFoundException } from '@nestjs/common';
import { VenueLinkService } from './venue-link.module';
import { Provenance } from '@prisma/client';
import { sha256 } from '../../common/util/hash';

/**
 * Venue-link (class 1b) invariants: link-code tenancy, provisional identity
 * with verified phone as merge key, venue_link evidence provenance, wallet
 * pass issuance, and idempotency pass-through.
 */
describe('VenueLinkService', () => {
  const link = {
    id: 'attr1',
    tenantId: 't1',
    venueId: 'v1',
    campaignId: 'ig-jul',
    code: 'CLUBX',
  };

  function makeService(opts: {
    existingPhoneLink?: any;
    inventory?: any[];
    bookingCount?: number;
    deposit?: number;
  }) {
    const created: Record<string, any[]> = {
      guests: [],
      links: [],
      payments: [],
    };
    const prisma: any = {
      attributionLink: {
        findUnique: async ({ where }: any) =>
          where.code === link.code ? link : null,
      },
      venue: {
        findFirst: async () => ({
          id: 'v1',
          tenantId: 't1',
          name: 'Club X',
          city: 'Miami',
        }),
      },
      inventory: {
        findMany: async () =>
          opts.inventory ?? [
            {
              id: 'i1',
              kind: 'table',
              label: 'Booth 1',
              capacity: 6,
              minSpend: 200000,
              deposit: 50000,
            },
          ],
      },
      booking: {
        count: async () => opts.bookingCount ?? 0,
        findFirst: async () => ({
          id: 'b1',
          date: new Date('2026-07-25'),
          partySize: 4,
          venue: { name: 'Club X' },
        }),
      },
      payment: {
        create: async ({ data }: any) => {
          created.payments.push(data);
          return { id: 'pay1', ...data };
        },
      },
      identityLink: {
        findUnique: async () => opts.existingPhoneLink ?? null,
        create: async ({ data }: any) => {
          created.links.push(data);
          return data;
        },
      },
      guest: {
        create: async ({ data }: any) => {
          const g = { id: 'g-new', ...data };
          created.guests.push(g);
          return g;
        },
        findFirst: async () => ({
          id: 'g-old',
          tenantId: 't1',
          walletPassId: 'wp_old',
        }),
      },
    };
    // inventory.findFirst for the deposit lookup at checkout
    prisma.inventory.findFirst = async () => ({
      id: 'i1',
      deposit: opts.deposit ?? 0,
    });
    const bookings: any = {
      create: jest.fn(async () => ({ id: 'b1', status: 'confirmed' })),
    };
    const stripe: any = {
      createPaymentIntent: jest.fn(async (amount: number, idem: string) => ({
        id: `pi_stub_${idem}`,
        clientSecret: 'secret_x',
        status: 'requires_payment_method',
      })),
    };
    const svc = new VenueLinkService(prisma, bookings, stripe);
    return { svc, bookings, created, stripe };
  }

  it('404s an unknown link code', async () => {
    const { svc } = makeService({});
    await expect(svc.map('NOPE')).rejects.toThrow(NotFoundException);
  });

  it('serves the venue map with availability and campaign attribution', async () => {
    const { svc } = makeService({ bookingCount: 6 });
    const map = await svc.map('CLUBX', '2026-07-25');
    expect(map.venue.name).toBe('Club X');
    expect(map.campaignId).toBe('ig-jul');
    expect(map.tables[0].available).toBe(false); // capacity 6, 6 taken
  });

  it('mints a provisional guest with verified phone link and wallet pass', async () => {
    const { svc, created } = makeService({});
    const res = await svc.checkout('CLUBX', {
      displayName: 'Dan',
      phone: '+61400000000',
      email: 'dan@example.com',
      date: '2026-07-25',
      partySize: 4,
      expressPay: true,
    } as any);
    const guest = created.guests[0];
    expect(guest.provisional).toBe(true);
    expect(guest.tenantId).toBe('t1');
    expect(res.walletPassId).toMatch(/^wp_/);
    const phoneLink = created.links.find((l) => l.kind === 'phone');
    expect(phoneLink.verified).toBe(true);
    expect(phoneLink.valueHash).toBe(sha256('+61400000000'));
    expect(phoneLink.source).toBe('venue_link');
    expect(res.appDeepLink).toContain(res.provisionalGuestId);
  });

  it('reuses the guest a verified phone already points to (no dupes)', async () => {
    const { svc, created } = makeService({
      existingPhoneLink: { guestId: 'g-old' },
    });
    const res = await svc.checkout('CLUBX', {
      displayName: 'Dan',
      phone: '+61400000000',
      date: '2026-07-25',
    } as any);
    expect(res.provisionalGuestId).toBe('g-old');
    expect(res.walletPassId).toBe('wp_old');
    expect(created.guests).toHaveLength(0);
  });

  it('opens a deposit PaymentIntent when the table carries a deposit', async () => {
    const { svc, created, stripe } = makeService({ deposit: 50000 });
    const res = await svc.checkout(
      'CLUBX',
      {
        displayName: 'Dan',
        phone: '+61400000000',
        date: '2026-07-25',
        inventoryId: 'i1',
      } as any,
      'idem-9',
    );
    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      50000,
      'idem-9:deposit',
    );
    expect(created.payments[0].amount).toBe(50000);
    expect(created.payments[0].bookingId).toBe('b1');
    expect(res.payment?.clientSecret).toBe('secret_x');
  });

  it('skips payment when the table has no deposit', async () => {
    const { svc, created } = makeService({ deposit: 0 });
    const res = await svc.checkout('CLUBX', {
      displayName: 'Dan',
      phone: '+61400000000',
      date: '2026-07-25',
      inventoryId: 'i1',
    } as any);
    expect(created.payments).toHaveLength(0);
    expect(res.payment).toBeNull();
  });

  it('serves an Apple-Wallet-shaped pass payload for a known pass id', async () => {
    const { svc } = makeService({});
    const pass = await svc.pass('wp_old');
    expect(pass.serialNumber).toBe('wp_old');
    expect(pass.barcode?.message).toBe('b1');
    expect(pass.description).toContain('Club X');
  });

  it('books through the standard machinery with venue_link provenance + attribution', async () => {
    const { svc, bookings } = makeService({});
    await svc.checkout(
      'CLUBX',
      {
        displayName: 'Dan',
        phone: '+61400000000',
        date: '2026-07-25',
        inventoryId: 'i1',
      } as any,
      'idem-123',
    );
    const [ctx, dto, idem, provenance] = bookings.create.mock.calls[0];
    expect(ctx.tenantId).toBe('t1');
    expect(dto.attributionId).toBe('attr1');
    expect(dto.venueId).toBe('v1');
    expect(idem).toBe('idem-123');
    expect(provenance).toBe(Provenance.venue_link);
    expect(dto.campaignId).toBe('ig-jul');
  });
});
