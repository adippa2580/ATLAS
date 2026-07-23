import { SplitGroupsService } from './split-groups.module';

/**
 * Captain-guarantee funding: the captain is authorized for the FULL total,
 * even splits sum exactly, and captured crew shares advance
 * authorized → partially_funded → funded.
 */
describe('SplitGroupsService captain guarantee', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('splitEvenCents sums exactly with deterministic remainder', () => {
    expect(SplitGroupsService.splitEvenCents(80_000, 3)).toEqual([
      26_667, 26_667, 26_666,
    ]);
    expect(SplitGroupsService.splitEvenCents(100, 4)).toEqual([25, 25, 25, 25]);
  });

  it('authorizes the captain for the full total, then shares under the group', async () => {
    const stripe: any = {
      createPaymentIntent: jest.fn(async (amount: number, key: string) => ({
        id: `pi_${key}`,
        status: 'requires_capture',
      })),
    };
    const events: any[] = [];
    const prisma: any = {
      booking: { findFirst: async () => ({ id: 'b1', tenantId: 't1' }) },
      splitGroup: {
        create: async ({ data }: any) => ({
          id: 'sg1',
          state: 'pending',
          fundedAmount: 0,
          ...data,
        }),
        update: async ({ data }: any) => data,
      },
      splitGroupEvent: {
        create: async ({ data }: any) => {
          events.push(data);
          return data;
        },
      },
      payment: { create: async ({ data }: any) => ({ id: 'p', ...data }) },
    };
    const svc = new SplitGroupsService(prisma, stripe);
    const res = await svc.createCaptainGuarantee(ctx, 'b1', {
      captainGuestId: 'g-cap',
      total: 80_000,
      shares: [{ guestId: 'g1' }, { guestId: 'g2' }, { guestId: 'g3' }],
    } as any);

    // Guarantee: FIRST intent is the captain's, for the FULL total.
    expect(stripe.createPaymentIntent).toHaveBeenNthCalledWith(
      1,
      80_000,
      'sg_sg1_captain_auth',
    );
    expect(res.state).toBe('authorized');
    expect(res.payments.map((p: any) => p.amount)).toEqual([
      26_667, 26_667, 26_666,
    ]);
    expect(res.payments.every((p: any) => p.kind === 'crew_share')).toBe(true);
    expect(events.map((e) => e.toState)).toEqual(['pending', 'authorized']);
  });

  it('refreshFunding advances authorized → partially_funded → funded', async () => {
    let state = 'authorized';
    let captured: { amount: number }[] = [{ amount: 20_000 }];
    const prisma: any = {
      splitGroup: {
        findUnique: async () => ({
          id: 'sg1',
          tenantId: 't1',
          totalAmount: 80_000,
          state,
        }),
        update: async ({ data }: any) => {
          if (data.state) state = data.state;
          return data;
        },
      },
      splitGroupEvent: { create: async ({ data }: any) => data },
      payment: { findMany: async () => captured },
    };
    const svc = new SplitGroupsService(prisma, {} as any);

    const partial: any = await svc.refreshFunding('sg1');
    expect(partial.fundedAmount).toBe(20_000);
    expect(partial.state).toBe('partially_funded');

    captured = [{ amount: 20_000 }, { amount: 60_000 }];
    const funded: any = await svc.refreshFunding('sg1');
    expect(funded.fundedAmount).toBe(80_000);
    expect(funded.state).toBe('funded');
  });
});
