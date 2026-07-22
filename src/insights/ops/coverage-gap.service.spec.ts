import { OpsInsightsService } from './ops-insights.module';

/**
 * Coverage-gap analysis — the identity pillar's largest negative driver. Over
 * attended bookings, what share are still un-enriched (provisional identity),
 * broken down worst-venue-first and trended by week.
 */
describe('OpsInsightsService.coverageGap', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;
  const at = (s: string) => new Date(`${s}T20:00:00.000Z`);

  function make(bookings: any[], walkIns = 0, backlog = 0) {
    const prisma: any = {
      booking: { findMany: async () => bookings },
      bookingStatusEvent: { count: async () => walkIns },
      guest: { count: async () => backlog },
    };
    return new OpsInsightsService(prisma);
  }

  it('computes coverage %, gap, and worst-venue-first split from provisional identity', async () => {
    const svc = make(
      [
        { venueId: 'vA', date: at('2026-07-01'), guest: { provisional: false } },
        { venueId: 'vA', date: at('2026-07-01'), guest: { provisional: false } },
        { venueId: 'vA', date: at('2026-07-01'), guest: { provisional: true } },
        { venueId: 'vB', date: at('2026-07-08'), guest: { provisional: true } },
        { venueId: 'vB', date: at('2026-07-08'), guest: null }, // missing → un-enriched
      ],
      4,
      7,
    );
    const r = await svc.coverageGap(ctx);

    expect(r.total).toBe(5);
    expect(r.unenriched).toBe(3);
    expect(r.enriched).toBe(2);
    expect(r.coveragePct).toBe(40);
    expect(r.gapPct).toBe(60);
    expect(r.walkInsCaptured).toBe(4);
    expect(r.provisionalBacklog).toBe(7);

    // worst gap first
    expect(r.byVenue[0].venueId).toBe('vB');
    expect(r.byVenue[0].coveragePct).toBe(0);
    expect(r.byVenue[1].venueId).toBe('vA');
    expect(r.byVenue[1].coveragePct).toBe(67);

    // weekly trend ascending, totals summing back to the whole
    expect(r.trend).toHaveLength(2);
    expect(r.trend[0].week < r.trend[1].week).toBe(true);
    expect(r.trend.reduce((a, t) => a + t.total, 0)).toBe(5);
  });

  it('returns null percentages (not NaN) when there are no attended bookings', async () => {
    const r = await make([]).coverageGap(ctx);
    expect(r.total).toBe(0);
    expect(r.coveragePct).toBeNull();
    expect(r.gapPct).toBeNull();
    expect(r.byVenue).toEqual([]);
    expect(r.trend).toEqual([]);
  });

  it('narrows to a single venue when venueId is passed through to the query', async () => {
    let where: any;
    const prisma: any = {
      booking: {
        findMany: async (args: any) => {
          where = args.where;
          return [];
        },
      },
      bookingStatusEvent: { count: async () => 0 },
      guest: { count: async () => 0 },
    };
    await new OpsInsightsService(prisma).coverageGap(ctx, 'vA');
    expect(where.venueId).toBe('vA');
    expect(where.tenantId).toBe('t1');
  });
});
