import { PaymentsService } from './payments.module';

/**
 * The Stripe webhook: a verified payment_intent.succeeded marks the payment
 * succeeded and — if it belongs to a captain-guarantee SplitGroup — advances
 * that group's funding via refreshFunding. Legacy ad-hoc split groups (no
 * SplitGroup row) are a no-op.
 */
describe('PaymentsService.handleWebhook funding hook', () => {
  const raw = (obj: unknown) => Buffer.from(JSON.stringify(obj));

  function make(payment: any) {
    const prisma: any = {
      payment: {
        findUnique: async () => payment,
        update: async ({ data }: any) => ({ ...payment, ...data }),
      },
    };
    const stripe: any = { verifyWebhook: () => true };
    const refreshFunding = jest.fn(async () => ({
      splitGroupId: 'sg1',
      fundedAmount: 40_000,
      state: 'partially_funded',
    }));
    const splitGroups: any = { refreshFunding };
    return {
      svc: new PaymentsService(prisma, stripe, splitGroups),
      refreshFunding,
    };
  }

  it('advances the split group when the succeeded payment carries a splitGroupId', async () => {
    const { svc, refreshFunding } = make({
      id: 'p1',
      tenantId: 't1',
      splitGroupId: 'sg1',
    });
    const res: any = await svc.handleWebhook(
      raw({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1' } },
      }),
      'sig',
    );
    expect(res.matched).toBe(1);
    expect(refreshFunding).toHaveBeenCalledWith('sg1');
    expect(res.funding).toMatchObject({ state: 'partially_funded' });
  });

  it('is a no-op for a legacy payment with no split group', async () => {
    const { svc, refreshFunding } = make({
      id: 'p1',
      tenantId: 't1',
      splitGroupId: null,
    });
    const res: any = await svc.handleWebhook(
      raw({
        type: 'payment_intent.succeeded',
        data: { object: { id: 'pi_1' } },
      }),
      'sig',
    );
    expect(res.matched).toBe(1);
    expect(refreshFunding).not.toHaveBeenCalled();
    expect(res.funding).toBeUndefined();
  });

  it('ignores non-succeeded event types without touching funding', async () => {
    const { svc, refreshFunding } = make({
      id: 'p1',
      tenantId: 't1',
      splitGroupId: 'sg1',
    });
    const res: any = await svc.handleWebhook(
      raw({ type: 'payment_intent.created', data: { object: { id: 'pi_1' } } }),
      'sig',
    );
    expect(res.ignored).toBe('payment_intent.created');
    expect(refreshFunding).not.toHaveBeenCalled();
  });
});
