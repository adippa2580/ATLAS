import {
  computeOutlookScore,
  OUTLOOK_WEIGHTS,
  OutlookService,
} from './outlook.module';

/**
 * Event Outlook rules engine v1 — weights sum to 1, all-neutral factors score
 * exactly 50, and a venue with no data (no baseline, no bookings, no
 * inventory) lands on the neutral 50, not 0.
 */
describe('OutlookService rules v1', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('weights sum to exactly 1', () => {
    const sum = Object.values(OUTLOOK_WEIGHTS).reduce((s, w) => s + w, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1);
  });

  it('all-neutral factors score 50', () => {
    const factors = Object.fromEntries(
      Object.keys(OUTLOOK_WEIGHTS).map((k) => [k, 0.5]),
    ) as any;
    expect(computeOutlookScore(factors)).toBe(50);
  });

  it('all-max factors score 100 and clamp above 1', () => {
    const factors = Object.fromEntries(
      Object.keys(OUTLOOK_WEIGHTS).map((k) => [k, 7]),
    ) as any;
    expect(computeOutlookScore(factors)).toBe(100);
  });

  it('a venue with no history computes the neutral 50 and persists it', async () => {
    const upsert = jest.fn(async ({ create }: any) => ({
      id: 'o1',
      ...create,
    }));
    const prisma: any = {
      booking: { findMany: async () => [] },
      inventory: { count: async () => 0 },
      eventOutlook: { upsert },
    };
    const svc = new OutlookService(prisma);
    const res = await svc.compute(ctx, 'v1', '2026-07-24');
    expect(res.score).toBe(50);
    expect(res.factors.demandPace).toBe(0.5);
    expect(res.factors.opsReadiness).toBe(0.5);
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(res.weightsVersion).toBe('v1-20/20/15/15/10/10/10');
  });
});
