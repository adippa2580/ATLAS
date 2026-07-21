import { CloseoutService } from './closeout.module';

/** Closeout: config-driven take-rate bps + V4 post-visit loyalty message. */
describe('CloseoutService', () => {
  function make(opts: { bps?: number; provisional?: any[] }) {
    const usage: any[] = [];
    const prisma: any = {
      booking: {
        findMany: async () => [
          { guestId: 'g1', tab: { total: 100_000 } },
          { guestId: 'g2', tab: { total: 60_000 } },
        ],
      },
      usageEvent: {
        create: async ({ data }: any) => {
          usage.push(data);
          return { id: 'u1', ...data };
        },
      },
      venue: { findFirst: async () => ({ id: 'v1', name: 'Club X' }) },
      guest: { findMany: async () => opts.provisional ?? [] },
    };
    const config: any = {
      get: (k: string) => (k === 'takeRateBps.closeout' ? opts.bps : undefined),
    };
    const klaviyo: any = { sendCampaign: jest.fn(async () => ({ delivered: 1 })) };
    return { svc: new CloseoutService(prisma, config, klaviyo), usage, klaviyo };
  }

  it('meters the configured bps of total tab (integer cents)', async () => {
    const { svc } = make({ bps: 1000 }); // 10%
    const res = await svc.closeout({ tenantId: 't1', scopes: [] } as any, 'v1', {});
    expect(res.totalTab).toBe(160_000);
    expect(res.takeRate).toBe(16_000);
    expect(res.takeRateBps).toBe(1000);
  });

  it('defaults to 500 bps when unconfigured (prior 5% behaviour)', async () => {
    const { svc } = make({});
    const res = await svc.closeout({ tenantId: 't1', scopes: [] } as any, 'v1', {});
    expect(res.takeRate).toBe(8_000);
  });

  it('fires the V4 post-visit message only to provisional guests', async () => {
    const { svc, klaviyo } = make({
      bps: 500,
      provisional: [{ id: 'g1' }],
    });
    const res = await svc.closeout({ tenantId: 't1', scopes: [] } as any, 'v1', {});
    expect(res.postVisitMessages).toBe(1);
    const [size, payload] = klaviyo.sendCampaign.mock.calls[0];
    expect(size).toBe(1);
    expect(payload.template).toBe('post_visit_loyalty_claim');
    expect(payload.message).toContain('Club X');
  });

  it('sends nothing when no provisional guests attended', async () => {
    const { svc, klaviyo } = make({ bps: 500, provisional: [] });
    const res = await svc.closeout({ tenantId: 't1', scopes: [] } as any, 'v1', {});
    expect(res.postVisitMessages).toBe(0);
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });
});
