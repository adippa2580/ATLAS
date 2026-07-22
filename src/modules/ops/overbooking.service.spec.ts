import { OverbookingService } from './overbooking.module';

/**
 * Overbooking guardrails: a table full of high-risk provisional bookings should
 * recover seats (positive recommendedOverbook, capped at +2), while a low-risk
 * table of known, deposit-backed guests should recommend nothing.
 */
describe('OverbookingService', () => {
  const DATE = '2026-07-22';
  const bookingDate = new Date(`${DATE}T20:00:00.000Z`);
  const createdAt = new Date(`${DATE}T12:00:00.000Z`); // short lead time

  // Two tables in one venue, capacity 4 each.
  const tables = [
    { id: 't-hi', label: 'Booth A', capacity: 4, deposit: null },
    { id: 't-lo', label: 'Booth B', capacity: 4, deposit: 20_000 },
  ];

  // 4 high-risk bookings on t-hi: provisional, big party, no deposit.
  const highRiskBookings = ['g-hi1', 'g-hi2', 'g-hi3', 'g-hi4'].map(
    (guestId, i) => ({
      id: `bh${i}`,
      guestId,
      inventoryId: 't-hi',
      status: 'confirmed',
      date: bookingDate,
      createdAt,
      partySize: 8,
      guest: { provisional: true },
      inventory: { deposit: null },
    }),
  );

  // 2 low-risk bookings on t-lo: known identity, deposit-backed, small party.
  const lowRiskBookings = ['g-lo1', 'g-lo2'].map((guestId, i) => ({
    id: `bl${i}`,
    guestId,
    inventoryId: 't-lo',
    status: 'confirmed',
    date: bookingDate,
    createdAt,
    partySize: 2,
    guest: { provisional: false },
    inventory: { deposit: 20_000 },
  }));

  function make(bookings: any[]) {
    const prisma: any = {
      inventory: {
        findMany: async () => tables,
      },
      booking: {
        findMany: async () => bookings,
        // prior-cancelled counts: every high-risk guest has one prior cancel.
        groupBy: async () =>
          bookings
            .filter((b) => b.guest.provisional)
            .map((b) => ({ guestId: b.guestId, _count: { _all: 1 } })),
      },
      trustEvent: {
        // high-risk guests carry a no_show (erodes trust); low-risk guests a
        // positive loyalty event (builds trust).
        findMany: async () =>
          bookings.map((b) =>
            b.guest.provisional
              ? { guestId: b.guestId, kind: 'no_show', weight: 3 }
              : { guestId: b.guestId, kind: 'loyalty', weight: 5 },
          ),
      },
    };
    return new OverbookingService(prisma);
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('recovers seats on a table full of high-risk provisional bookings', async () => {
    const svc = make(highRiskBookings);
    const res = await svc.policy(ctx, 'v1', DATE);

    expect(res.tenantId).toBe('t1');
    expect(res.venueId).toBe('v1');
    expect(res.date).toBe(DATE);

    const hi = res.tables.find((t) => t.inventoryId === 't-hi')!;
    expect(hi.bookedCount).toBe(4);
    expect(hi.expectedNoShows).toBeGreaterThan(1);
    expect(hi.recommendedOverbook).toBeGreaterThan(0);
    // Never adds more than +2 per table.
    expect(hi.recommendedOverbook).toBeLessThanOrEqual(2);
    expect(hi.newEffectiveCapacity).toBe(hi.capacity + hi.recommendedOverbook);
    expect(res.totalRecoverableSeats).toBe(hi.recommendedOverbook);
  });

  it('recommends no overbook on a low-risk, deposit-backed table', async () => {
    const svc = make(lowRiskBookings);
    const res = await svc.policy(ctx, 'v1', DATE);

    const lo = res.tables.find((t) => t.inventoryId === 't-lo')!;
    expect(lo.bookedCount).toBe(2);
    expect(lo.recommendedOverbook).toBe(0);
    expect(lo.newEffectiveCapacity).toBe(lo.capacity);
    // The empty high-risk table (no bookings) also recommends nothing.
    const hi = res.tables.find((t) => t.inventoryId === 't-hi')!;
    expect(hi.bookedCount).toBe(0);
    expect(hi.recommendedOverbook).toBe(0);
    expect(res.totalRecoverableSeats).toBe(0);
  });
});
