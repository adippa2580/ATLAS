import { StripeAdapter } from './stripe.adapter';

/**
 * The stub PaymentIntent id must be UNIQUE per idempotency key. Payment.stripePiId
 * is @unique, and every key in one split group shares a prefix (`sg_<uuid>_…`,
 * `split_<uuid>_…`); a truncated stub id would collide on the 2nd insert (P2002)
 * and break createCaptainGuarantee / splitPay at runtime. Regression guard.
 */
describe('StripeAdapter stub createPaymentIntent', () => {
  const adapter = new StripeAdapter({ get: () => undefined } as any);

  it('returns a distinct id for each distinct idempotency key in a split group', async () => {
    const group = 'sg_1b9d6bcd-1111-2222-3333-444455556666';
    const keys = [
      `${group}_captain_auth`,
      `${group}_g1`,
      `${group}_g2`,
      `${group}_g3`,
      `${group}_captain_remainder`,
    ];
    const ids = await Promise.all(
      keys.map((k) => adapter.createPaymentIntent(1000, k).then((r) => r.id)),
    );
    expect(new Set(ids).size).toBe(keys.length);
  });

  it('is deterministic: the same key yields the same id (Stripe idempotency)', async () => {
    const a = await adapter.createPaymentIntent(1000, 'split_abc_g1');
    const b = await adapter.createPaymentIntent(1000, 'split_abc_g1');
    expect(a.id).toBe(b.id);
  });
});
