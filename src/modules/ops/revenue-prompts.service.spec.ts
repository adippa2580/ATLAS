import { RevenuePromptsService } from './revenue-prompts.module';

/**
 * Revenue prompts — two levers:
 *   1. midweek taste-matched menus: categories rank by combined historical
 *      line-item spend + tonight's guest product/genre affinity.
 *   2. bottle-service attach prompts: per-booking attach suggestions learned
 *      from historical tabs, prioritising guests with matching spend affinity.
 *
 * Hand-rolled Prisma stub (style: closeout.service.spec.ts). booking.findMany
 * branches on the `where.date` shape: `{ lt }` → historical, `{ gte }` → tonight.
 */
describe('RevenuePromptsService', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make(opts: {
    historical?: any[];
    tonight?: any[];
    affinities?: any[];
  }) {
    const calls: any = { bookingWheres: [], affinityWheres: [] };
    const prisma: any = {
      booking: {
        findMany: async ({ where }: any) => {
          calls.bookingWheres.push(where);
          const isTonight = where?.date?.gte != null;
          return isTonight ? (opts.tonight ?? []) : (opts.historical ?? []);
        },
      },
      guestAffinity: {
        findMany: async ({ where }: any) => {
          calls.affinityWheres.push(where);
          return opts.affinities ?? [];
        },
      },
    };
    return { svc: new RevenuePromptsService(prisma), calls };
  }

  // -------------------------------------------------------------------------
  // Lever 1 — midweek taste-matched menus
  // -------------------------------------------------------------------------

  it('ranks categories by combined historical spend + tonight affinity', async () => {
    const { svc } = make({
      historical: [
        { tab: { lineItems: [{ name: 'Dom Perignon', amount: 100_000 }] } },
        { tab: { lineItems: [{ name: 'Don Julio 1942', amount: 60_000 }] } },
      ],
      tonight: [{ id: 'b1', guestId: 'g1' }],
      // Guest skews tequila tonight; champagne has no affinity but more spend.
      affinities: [
        { guestId: 'g1', subjectRef: 'Don Julio Tequila', score: 8 },
      ],
    });

    const res: any = await svc.midweekMenu(ctx, 'v1', '2026-07-22');

    // champagne: spendShare 1.0 + aff 0    = 1.0
    // tequila:   spendShare 0.6 + aff 1.0  = 1.6  -> ranks first despite less spend
    expect(res.suggestions[0].category).toBe('tequila');
    expect(res.suggestions[0].affinityWeight).toBe(8);
    expect(res.suggestions[0].historicalSpendCents).toBe(60_000);
    expect(res.suggestions[0].combinedScore).toBeCloseTo(1.6, 4);
    expect(res.suggestions[1].category).toBe('champagne');
    expect(res.suggestions[0].combinedScore).toBeGreaterThan(
      res.suggestions[1].combinedScore,
    );
  });

  it('flags soft-midweek framing on a Wed and off-midweek on a Sat', async () => {
    const { svc } = make({ historical: [], tonight: [], affinities: [] });
    const wed: any = await svc.midweekMenu(ctx, 'v1', '2026-07-22');
    const sat: any = await svc.midweekMenu(ctx, 'v1', '2026-07-25');
    expect(wed.midweek).toBe(true);
    expect(wed.framing).toBe('soft-midweek');
    expect(sat.midweek).toBe(false);
    expect(sat.framing).toBe('off-midweek');
  });

  it('reads historical (date lt) and tonight (date gte) bookings tenant-scoped', async () => {
    const { svc, calls } = make({
      historical: [],
      tonight: [],
      affinities: [],
    });
    await svc.midweekMenu(ctx, 'v1', '2026-07-22');
    for (const w of calls.bookingWheres) {
      expect(w.tenantId).toBe('t1');
      expect(w.venueId).toBe('v1');
    }
    expect(
      calls.bookingWheres.some((w: any) => w.date?.lt && !w.date?.gte),
    ).toBe(true);
    expect(calls.bookingWheres.some((w: any) => w.date?.gte)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Lever 2 — bottle-service attach prompts
  // -------------------------------------------------------------------------

  const attachHistorical = [
    { tab: { lineItems: [{ name: 'Dom Perignon', amount: 50_000 }] } }, // champagne
    {
      tab: {
        lineItems: [
          { name: 'Don Julio 1942', amount: 30_000 }, // tequila
          { name: 'Still Water', amount: 1_000 }, // na
        ],
      },
    },
    { tab: { lineItems: [{ name: 'Grey Goose', amount: 20_000 }] } }, // spirit
    { tab: { lineItems: [{ name: 'Casamigos', amount: 40_000 }] } }, // tequila
  ];

  it('computes attach rate + avg uplift and surfaces prompts per booking', async () => {
    const { svc } = make({
      historical: attachHistorical,
      tonight: [
        { id: 'b1', guestId: 'g1' },
        { id: 'b2', guestId: 'g2' },
      ],
      affinities: [],
    });

    const res: any = await svc.attachPrompts(ctx, 'v1', '2026-07-22');

    expect(res.historicalTabs).toBe(4);
    const tequila = res.categoryStats.find(
      (s: any) => s.category === 'tequila',
    );
    // 2 of 4 tabs carried tequila; avg uplift (30_000 + 40_000) / 2 = 35_000.
    expect(tequila.attachRate).toBe(0.5);
    expect(tequila.avgUpliftCents).toBe(35_000);
    const champagne = res.categoryStats.find(
      (s: any) => s.category === 'champagne',
    );
    expect(champagne.attachRate).toBe(0.25);
    expect(champagne.avgUpliftCents).toBe(50_000);

    // A prompt is emitted for every booking of the night.
    expect(res.prompts).toHaveLength(2);
    for (const p of res.prompts) {
      expect(p.suggestedAttach.length).toBeGreaterThan(0);
    }
  });

  it('prioritises guests with matching spend affinity and surfaces the match first', async () => {
    const { svc } = make({
      historical: attachHistorical,
      tonight: [
        { id: 'b1', guestId: 'g1' }, // no affinity
        { id: 'b2', guestId: 'g2' }, // tequila affinity
      ],
      affinities: [{ guestId: 'g2', subjectRef: 'Don Julio', score: 9 }],
    });

    const res: any = await svc.attachPrompts(ctx, 'v1', '2026-07-22');

    // g2 (tequila affinity) is prioritised to the top.
    expect(res.prompts[0].bookingId).toBe('b2');
    expect(res.prompts[0].priorityScore).toBe(9);
    // The matched, high-margin category leads that booking's suggestions.
    expect(res.prompts[0].suggestedAttach[0].category).toBe('tequila');
    expect(res.prompts[0].suggestedAttach[0].matched).toBe(true);
    expect(res.prompts[0].suggestedAttach[0].avgUpliftCents).toBe(35_000);
    // The unmatched booking sorts below and carries no match.
    expect(res.prompts[1].bookingId).toBe('b1');
    expect(res.prompts[1].priorityScore).toBe(0);
    expect(
      res.prompts[1].suggestedAttach.every((s: any) => s.matched === false),
    ).toBe(true);
  });

  it('scopes affinity + booking reads to the tenant', async () => {
    const { svc, calls } = make({
      historical: attachHistorical,
      tonight: [{ id: 'b1', guestId: 'g1' }],
      affinities: [],
    });
    await svc.attachPrompts(ctx, 'v1', '2026-07-22');
    for (const w of calls.bookingWheres) expect(w.tenantId).toBe('t1');
    for (const w of calls.affinityWheres) {
      expect(w.tenantId).toBe('t1');
      expect(w.muted).toBe(false);
      expect(w.subjectType.in).toEqual(['product', 'genre']);
    }
  });
});
