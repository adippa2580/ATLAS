import { PosBackfillService } from './pos-backfill.module';

/**
 * POS backfill: settled tabs -> per-line `spend` taste evidence (provenance
 * `pos`), attributed to the tab's guest, idempotent by per-line dedupeKey.
 */
describe('PosBackfillService', () => {
  const baseTabs = [
    {
      id: 'tab1',
      closedAt: new Date('2026-07-01T04:00:00.000Z'),
      createdAt: new Date('2026-07-01T02:00:00.000Z'),
      lineItems: [
        { name: 'Dom Perignon', amount: 45_000 },
        { name: 'Don Julio 1942', amount: 30_000 },
      ],
      booking: { guestId: 'g1', venueId: 'v1' },
    },
    {
      id: 'tab2',
      closedAt: new Date('2026-07-02T04:00:00.000Z'),
      createdAt: new Date('2026-07-02T02:00:00.000Z'),
      lineItems: [{ name: 'Heineken', amount: 1_500 }],
      booking: { guestId: 'g2', venueId: 'v2' },
    },
  ];

  function make(opts: { tabs?: any[] } = {}) {
    const published: any[] = [];
    const bus: any = {
      publish: jest.fn(async (msg: any) => {
        published.push(msg);
      }),
    };
    const prisma: any = {
      tab: {
        findMany: async (_args: any) => opts.tabs ?? baseTabs,
      },
    };
    return {
      svc: new PosBackfillService(prisma, bus),
      bus,
      published,
    };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('emits one spend/pos evidence per line item and returns counts', async () => {
    const { svc, published } = make();
    const res = await svc.backfill(ctx, {});

    expect(res).toEqual({
      tenantId: 't1',
      tabsScanned: 2,
      evidenceEmitted: 3,
    });
    expect(published).toHaveLength(3);
    for (const msg of published) {
      expect(msg.signal).toBe('spend');
      expect(msg.provenance).toBe('pos');
      expect(msg.subjectType).toBe('product');
      expect(msg.tenantId).toBe('t1');
    }
  });

  it('attributes each line to the tab guest, categorises the SKU, and weights by spend', async () => {
    const { svc, published } = make();
    await svc.backfill(ctx, {});

    const champagne = published.find((m) => m.subjectRef === 'champagne');
    expect(champagne.guestId).toBe('g1');
    expect(champagne.weight).toBe(45); // 45_000c / 1000
    expect(champagne.observedAt).toBe('2026-07-01T04:00:00.000Z');

    const tequila = published.find((m) => m.subjectRef === 'tequila');
    expect(tequila.guestId).toBe('g1');

    const beer = published.find((m) => m.subjectRef === 'beer');
    expect(beer.guestId).toBe('g2');
  });

  it('uses a stable per-tab-line dedupeKey so a re-run does not double-count', async () => {
    const { svc: svcA, published: runA } = make();
    await svcA.backfill(ctx, {});
    const { svc: svcB, published: runB } = make();
    await svcB.backfill(ctx, {});

    const keysA = runA.map((m) => m.dedupeKey);
    const keysB = runB.map((m) => m.dedupeKey);
    // Deterministic across runs (persistence layer dedupes on these).
    expect(keysA).toEqual(keysB);
    // Distinct per line within a run.
    expect(new Set(keysA).size).toBe(keysA.length);
  });

  it('skips comp/refund (non-positive) lines', async () => {
    const { svc, published } = make({
      tabs: [
        {
          id: 'tab3',
          closedAt: new Date('2026-07-03T04:00:00.000Z'),
          createdAt: new Date('2026-07-03T02:00:00.000Z'),
          lineItems: [
            { name: 'Grey Goose', amount: 20_000 },
            { name: 'Manager Comp', amount: 0 },
            { name: 'Refund', amount: -5_000 },
          ],
          booking: { guestId: 'g3', venueId: 'v1' },
        },
      ],
    });
    const res = await svc.backfill(ctx, {});
    expect(res.evidenceEmitted).toBe(1);
    expect(published).toHaveLength(1);
    expect(published[0].subjectRef).toBe('spirit');
  });

  it('handles tabs with missing/empty line items without emitting', async () => {
    const { svc, published } = make({
      tabs: [
        {
          id: 'tab4',
          closedAt: new Date('2026-07-04T04:00:00.000Z'),
          createdAt: new Date('2026-07-04T02:00:00.000Z'),
          lineItems: null,
          booking: { guestId: 'g4', venueId: 'v1' },
        },
      ],
    });
    const res = await svc.backfill(ctx, {});
    expect(res).toEqual({
      tenantId: 't1',
      tabsScanned: 1,
      evidenceEmitted: 0,
    });
    expect(published).toHaveLength(0);
  });
});
