import { DepositsService } from './deposits.module';

/**
 * Risk-based deposit policy: soften for known low-risk guests, require a
 * deposit-backed hold for provisional / high-no-show-risk bookings, standard
 * otherwise. Amounts are integer cents and the hold charges exactly the quoted
 * amount. Reuses the grounded no-show risk model.
 */
describe('DepositsService deposit policy', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;
  const createdAt = new Date('2026-07-01T00:00:00.000Z');
  const date = new Date('2026-07-02T00:00:00.000Z'); // 24h lead — no lead penalty

  function make(opts: {
    provisional: boolean;
    deposit: number | null;
    minSpend?: number | null;
    trust?: { kind: string; weight: number }[];
    cancelled?: number;
    partySize?: number;
  }) {
    const booking = {
      id: 'b1',
      tenantId: 't1',
      guestId: 'g1',
      partySize: opts.partySize ?? 2,
      date,
      createdAt,
      inventory: { deposit: opts.deposit, minSpend: opts.minSpend ?? null },
      guest: { provisional: opts.provisional },
    };
    const stripe: any = {
      createPaymentIntent: jest.fn(async (amount: number, key: string) => ({
        id: `pi_${key}_${amount}`,
        status: 'requires_capture',
      })),
    };
    const prisma: any = {
      booking: {
        findFirst: async () => booking,
        groupBy: async () =>
          opts.cancelled
            ? [{ guestId: 'g1', _count: { _all: opts.cancelled } }]
            : [],
      },
      trustEvent: { findMany: async () => opts.trust ?? [] },
      payment: {
        create: async ({ data }: any) => ({ id: 'p1', ...data }),
      },
    };
    return { svc: new DepositsService(prisma, stripe), stripe };
  }

  it('softens (halves) the deposit for a known, low-risk guest', async () => {
    const { svc } = make({
      provisional: false,
      deposit: 50_000,
      trust: [{ kind: 'positive', weight: 3 }],
    });
    const q = await svc.quote(ctx, 'b1');
    expect(q.policy).toBe('softened');
    expect(q.requiredDepositCents).toBe(25_000);
    expect(q.identityMatched).toBe(true);
    expect(q.riskScore).toBeLessThan(35);
  });

  it('requires a deposit-backed hold for a provisional identity (uses base deposit)', async () => {
    const { svc } = make({ provisional: true, deposit: 50_000 });
    const q = await svc.quote(ctx, 'b1');
    expect(q.policy).toBe('backed-hold');
    expect(q.requiredDepositCents).toBe(50_000);
    expect(q.provisional).toBe(true);
  });

  it('floors a backed-hold at 20% of min-spend when no deposit is configured', async () => {
    const { svc } = make({
      provisional: true,
      deposit: null,
      minSpend: 200_000,
    });
    const q = await svc.quote(ctx, 'b1');
    expect(q.policy).toBe('backed-hold');
    expect(q.requiredDepositCents).toBe(40_000);
  });

  it('applies the standard deposit for a mid-risk known guest', async () => {
    const { svc } = make({
      provisional: false,
      deposit: 40_000,
      cancelled: 2, // +16 risk → lands in the standard band
    });
    const q = await svc.quote(ctx, 'b1');
    expect(q.policy).toBe('standard');
    expect(q.requiredDepositCents).toBe(40_000);
    expect(q.tier).toBe('standard');
  });

  it('hold() charges exactly the policy-quoted amount', async () => {
    const { svc, stripe } = make({
      provisional: false,
      deposit: 50_000,
      trust: [{ kind: 'positive', weight: 3 }],
    });
    const payment: any = await svc.hold(ctx, 'b1');
    expect(stripe.createPaymentIntent).toHaveBeenCalledWith(
      25_000,
      'deposit_b1',
    );
    expect(payment.amount).toBe(25_000);
    expect(payment.payerGuestId).toBe('g1');
  });
});
