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

  it('refreshFunding only sums succeeded crew_share / captain_remainder', async () => {
    // The mock asserts the query filter so a regression that counted pending or
    // captain_authorization amounts would be caught, not silently passed.
    const prisma: any = {
      splitGroup: {
        findUnique: async () => ({
          id: 'sg1',
          tenantId: 't1',
          totalAmount: 80_000,
          state: 'authorized',
        }),
        update: async ({ data }: any) => data,
      },
      splitGroupEvent: { create: async ({ data }: any) => data },
      payment: {
        findMany: async ({ where }: any) => {
          expect(where.status).toBe('succeeded');
          expect(where.kind).toEqual({
            in: ['crew_share', 'captain_remainder'],
          });
          expect(where.tenantId).toBe('t1');
          return [{ amount: 30_000 }];
        },
      },
    };
    const svc = new SplitGroupsService(prisma, {} as any);
    const res: any = await svc.refreshFunding('sg1');
    expect(res.fundedAmount).toBe(30_000);
    expect(res.state).toBe('partially_funded');
  });

  it('refreshFunding on an already-funded group recomputes amount without re-transitioning', async () => {
    const events: any[] = [];
    const prisma: any = {
      splitGroup: {
        findUnique: async () => ({
          id: 'sg1',
          tenantId: 't1',
          totalAmount: 80_000,
          state: 'funded',
        }),
        update: async ({ data }: any) => data,
      },
      splitGroupEvent: {
        create: async ({ data }: any) => {
          events.push(data);
          return data;
        },
      },
      payment: { findMany: async () => [{ amount: 80_000 }] },
    };
    const svc = new SplitGroupsService(prisma, {} as any);
    const res: any = await svc.refreshFunding('sg1');
    expect(res.fundedAmount).toBe(80_000);
    expect(res.state).toBe('funded');
    expect(events).toHaveLength(0); // no duplicate ledger event
  });

  it('settle draws the captain remainder for the unfunded balance and marks settled', async () => {
    const stripe: any = {
      createPaymentIntent: jest.fn(async (amount: number, key: string) => ({
        id: `pi_${key}`,
        status: 'requires_capture',
      })),
    };
    const events: any[] = [];
    const created: any[] = [];
    let state = 'authorized';
    const prisma: any = {
      splitGroup: {
        findFirst: async () => ({
          id: 'sg1',
          tenantId: 't1',
          bookingId: 'b1',
          captainGuestId: 'g-cap',
          totalAmount: 80_000,
          fundedAmount: 0,
          state,
        }),
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
      splitGroupEvent: {
        create: async ({ data }: any) => {
          events.push(data);
          return data;
        },
      },
      payment: {
        findMany: async () => [{ amount: 50_000 }], // only 50k of 80k crew-funded
        create: async ({ data }: any) => {
          created.push(data);
          return { id: 'p', ...data };
        },
      },
    };
    const svc = new SplitGroupsService(prisma, stripe);
    const res: any = await svc.settle(ctx, 'sg1');

    expect(res.state).toBe('settled');
    expect(res.remainderCents).toBe(30_000); // 80k - 50k
    // Captain remainder PI drawn for exactly the gap, kind captain_remainder.
    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      30_000,
      'sg_sg1_captain_remainder',
    );
    expect(created[0].kind).toBe('captain_remainder');
    expect(created[0].payerGuestId).toBe('g-cap');
    expect(events.at(-1).toState).toBe('settled');
  });

  it('settle with full crew funding draws no captain PI', async () => {
    const stripe: any = { createPaymentIntent: jest.fn() };
    let state = 'authorized';
    const prisma: any = {
      splitGroup: {
        findFirst: async () => ({
          id: 'sg1',
          tenantId: 't1',
          bookingId: 'b1',
          captainGuestId: 'g-cap',
          totalAmount: 80_000,
          fundedAmount: 0,
          state,
        }),
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
      payment: {
        findMany: async () => [{ amount: 80_000 }], // fully crew-funded
        create: async () => {
          throw new Error('should not create a captain remainder PI');
        },
      },
    };
    const svc = new SplitGroupsService(prisma, stripe);
    const res: any = await svc.settle(ctx, 'sg1');
    expect(res.state).toBe('settled');
    expect(res.remainderCents).toBe(0);
    expect(stripe.createPaymentIntent).not.toHaveBeenCalled();
  });

  it('expire releases the guarantee and logs the transition', async () => {
    const events: any[] = [];
    const prisma: any = {
      splitGroup: {
        findFirst: async () => ({
          id: 'sg1',
          tenantId: 't1',
          state: 'authorized',
        }),
        update: async ({ data }: any) => data,
      },
      splitGroupEvent: {
        create: async ({ data }: any) => {
          events.push(data);
          return data;
        },
      },
    };
    const svc = new SplitGroupsService(prisma, {} as any);
    const res: any = await svc.expire(ctx, 'sg1');
    expect(res.state).toBe('expired');
    expect(events.at(-1)).toMatchObject({
      fromState: 'authorized',
      toState: 'expired',
    });
  });

  it('rejects an illegal transition (settle on an already-settled group)', async () => {
    const prisma: any = {
      splitGroup: {
        findFirst: async () => ({
          id: 'sg1',
          tenantId: 't1',
          bookingId: 'b1',
          captainGuestId: 'g-cap',
          totalAmount: 80_000,
          fundedAmount: 80_000,
          state: 'settled',
        }),
        findUnique: async () => ({
          id: 'sg1',
          tenantId: 't1',
          totalAmount: 80_000,
          state: 'settled',
        }),
        update: async ({ data }: any) => data,
      },
      splitGroupEvent: { create: async ({ data }: any) => data },
      payment: { findMany: async () => [{ amount: 80_000 }] },
    };
    const svc = new SplitGroupsService(prisma, {} as any);
    await expect(svc.settle(ctx, 'sg1')).rejects.toThrow(
      /Illegal funding transition/,
    );
  });
});
