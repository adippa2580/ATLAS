import { CloseoutService } from './closeout.module';

/**
 * Closeout: W7 per-booking take-rate (PLACEHOLDER bps, adopted 2026-07-21
 * pending Jack), legacy tab fallback, and the V4 post-visit message.
 */
describe('CloseoutService', () => {
  const baseBookings = [
    {
      id: 'b1',
      guestId: 'g1',
      status: 'confirmed',
      attributionId: 'attr1',
      inventory: { kind: 'table', minSpend: 200_000 },
      tab: { total: 100_000 },
    },
    {
      id: 'b2',
      guestId: 'g2',
      status: 'confirmed',
      attributionId: null,
      inventory: { kind: 'ticket', minSpend: null },
      tab: { total: 60_000 },
    },
  ];

  function make(opts: {
    bps?: Partial<Record<'table' | 'ticket' | 'closeout', number>>;
    provisional?: any[];
    bookings?: any[];
  }) {
    const usage: any[] = [];
    const prisma: any = {
      booking: { findMany: async () => opts.bookings ?? baseBookings },
      usageEvent: {
        create: async ({ data }: any) => {
          usage.push(data);
          return { id: `u${usage.length}`, ...data };
        },
      },
      attributionLink: {
        findMany: async () => [{ id: 'attr1', campaignId: 'ig-jul' }],
      },
      venue: { findFirst: async () => ({ id: 'v1', name: 'Club X' }) },
      guest: { findMany: async () => opts.provisional ?? [] },
    };
    const config: any = {
      get: (k: string) => {
        if (k === 'takeRateBps.table') return opts.bps?.table;
        if (k === 'takeRateBps.ticket') return opts.bps?.ticket;
        if (k === 'takeRateBps.closeout') return opts.bps?.closeout;
        return undefined;
      },
    };
    const klaviyo: any = {
      sendCampaign: jest.fn(async () => ({ delivered: 1 })),
    };
    return {
      svc: new CloseoutService(prisma, config, klaviyo),
      usage,
      klaviyo,
    };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('meters per-booking with placeholder bps: table on minimum, ticket on tab', async () => {
    const { svc, usage } = make({}); // defaults: 1000 / 800
    const res = await svc.closeout(ctx, 'v1', {});
    // table: 200_000 * 10% = 20_000 · ticket: 60_000 * 8% = 4_800
    expect(res.takeRate).toBe(24_800);
    expect(res.takeRateModel).toBe('per_booking');
    const b1 = usage.find((u) => u.bookingId === 'b1');
    expect(b1.billableAmount).toBe(20_000);
    expect(b1.path).toBe('venue_link');
    expect(b1.campaignId).toBe('ig-jul');
    const b2 = usage.find((u) => u.bookingId === 'b2');
    expect(b2.billableAmount).toBe(4_800);
    expect(b2.path).toBe('app');
  });

  it('skips cancelled bookings in the per-booking model', async () => {
    const { svc } = make({
      bookings: [{ ...baseBookings[0], status: 'cancelled' }, baseBookings[1]],
    });
    const res = await svc.closeout(ctx, 'v1', {});
    expect(res.takeRate).toBe(4_800);
  });

  it('falls back to the aggregate tab rate when table/ticket bps are 0', async () => {
    const { svc, usage } = make({
      bps: { table: 0, ticket: 0, closeout: 500 },
    });
    const res = await svc.closeout(ctx, 'v1', {});
    expect(res.takeRateModel).toBe('closeout_tab');
    expect(res.takeRate).toBe(8_000); // 5% of 160_000
    expect(usage).toHaveLength(1);
  });

  it('fires the V4 post-visit message only to provisional guests', async () => {
    const { svc, klaviyo } = make({ provisional: [{ id: 'g1' }] });
    const res = await svc.closeout(ctx, 'v1', {});
    expect(res.postVisitMessages).toBe(1);
    const [size, payload] = klaviyo.sendCampaign.mock.calls[0];
    expect(size).toBe(1);
    expect(payload.template).toBe('post_visit_loyalty_claim');
    expect(payload.message).toContain('Club X');
  });

  it('sends nothing when no provisional guests attended', async () => {
    const { svc, klaviyo } = make({ provisional: [] });
    const res = await svc.closeout(ctx, 'v1', {});
    expect(res.postVisitMessages).toBe(0);
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });
});
