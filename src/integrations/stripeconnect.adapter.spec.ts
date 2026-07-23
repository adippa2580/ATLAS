import { StripeConnectAdapter } from './stripeconnect.adapter';

/** Stripe Connect adapter: stub account/transfer rails + integer-cent fees. */
describe('StripeConnectAdapter', () => {
  function make(cfg: Record<string, string | undefined> = {}) {
    return new StripeConnectAdapter({
      get: (k: string) => cfg[k],
    } as any);
  }

  it('creates a deterministic stub connected account for a venue', async () => {
    const a = make();
    const acct = await a.createConnectedAccount('venue_42');
    expect(acct.accountId).toBe('acct_stub_venue_42');
    expect(acct.status).toBe('pending');
    expect(typeof acct.onboardingUrl).toBe('string');
    expect(acct.onboardingUrl.length).toBeGreaterThan(0);
  });

  it('creates a stub transfer echoing integer cents back', async () => {
    const a = make();
    const tr = await a.createTransfer(250000, 'acct_stub_venue_42', 'key-1');
    expect(tr.transferId).toBe('tr_stub_key-1');
    expect(tr.amount).toBe(250000);
    expect(Number.isInteger(tr.amount)).toBe(true);
    expect(tr.status).toBe('pending');
  });

  it('returns distinct transfer ids for distinct idempotency keys', async () => {
    const a = make();
    const first = await a.createTransfer(1000, 'acct_stub_v', 'key-a');
    const second = await a.createTransfer(1000, 'acct_stub_v', 'key-b');
    expect(first.transferId).not.toBe(second.transferId);
  });

  it('computes the application fee in integer cents', () => {
    const a = make();
    // 10% of $2500.00 = $250.00.
    expect(a.applicationFeeCents(250000, 1000)).toBe(25000);
    // Rounding case: 2.5% of 12345 cents = 308.625 → 309.
    expect(a.applicationFeeCents(12345, 250)).toBe(309);
    expect(Number.isInteger(a.applicationFeeCents(12345, 250))).toBe(true);
  });

  it('normalises a payout variant into integer cents', () => {
    const a = make();
    const payout = a.normalizePayout({
      payout_id: 'po_live_1',
      destination: 'acct_stub_venue_42',
      amount: 199999.6,
      status: 'in_transit',
    });
    expect(payout.externalPayoutId).toBe('po_live_1');
    expect(payout.accountId).toBe('acct_stub_venue_42');
    expect(payout.amountCents).toBe(200000);
    expect(Number.isInteger(payout.amountCents)).toBe(true);
    expect(payout.status).toBe('in_transit');
  });
});
