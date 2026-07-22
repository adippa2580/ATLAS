import { BookingsService } from './bookings.module';

/**
 * Extend instant-confirm coverage — auto-confirm a HELD booking for a known,
 * low-risk guest. Confirm iff `!provisional && riskScore < 35`, transitioning
 * `held → confirmed` in the SAME transaction as the §4.1 ledger write, then
 * publishing `book` evidence + a metering event (mirroring the confirm path).
 *
 * Hand-rolled Prisma stub (style: closeout.service.spec.ts) whose `$transaction`
 * simply runs its callback against the same client.
 */
describe('BookingsService.autoConfirm', () => {
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function make(opts: {
    booking: any;
    trustEvents?: { kind: string; weight: number }[];
    priorCancelled?: number;
  }) {
    const ledger: any[] = [];
    const usage: any[] = [];
    const evidence: any[] = [];
    const updates: any[] = [];

    const tx: any = {
      booking: {
        update: async ({ where, data }: any) => {
          updates.push({ where, data });
          return { ...opts.booking, ...data };
        },
      },
      bookingStatusEvent: {
        create: async ({ data }: any) => {
          ledger.push(data);
          return { id: `bse${ledger.length}`, ...data };
        },
      },
    };

    const prisma: any = {
      booking: {
        findFirst: async () => opts.booking,
        count: async () => opts.priorCancelled ?? 0,
      },
      trustEvent: {
        findMany: async () => opts.trustEvents ?? [],
      },
      usageEvent: {
        create: async ({ data }: any) => {
          usage.push(data);
          return { id: `u${usage.length}`, ...data };
        },
      },
      $transaction: async (cb: any) => cb(tx),
    };

    const bus: any = {
      publish: async (msg: any) => {
        evidence.push(msg);
      },
    };

    return {
      svc: new BookingsService(prisma, bus),
      ledger,
      usage,
      evidence,
      updates,
    };
  }

  // A confirmed low-risk booking: non-provisional, deposit on the table, short
  // lead, small party, positive trust → riskScore comfortably < 35.
  const lowRiskBooking = {
    id: 'bk1',
    tenantId: 't1',
    venueId: 'v1',
    guestId: 'g1',
    status: 'held',
    partySize: 2,
    date: new Date('2026-07-23T00:00:00.000Z'),
    createdAt: new Date('2026-07-22T00:00:00.000Z'), // 24h lead
    guest: { provisional: false },
    inventory: { deposit: 20_000 },
  };

  it('confirms a known low-risk guest: held→confirmed + single ledger write + evidence + metering', async () => {
    const { svc, ledger, usage, evidence, updates } = make({
      booking: lowRiskBooking,
      trustEvents: [{ kind: 'positive', weight: 3 }],
      priorCancelled: 0,
    });

    const res: any = await svc.autoConfirm(ctx, 'bk1');

    expect(res.confirmed).toBe(true);
    expect(res.riskScore).toBeLessThan(35);
    expect(res.booking.status).toBe('confirmed');

    // Status write happened.
    expect(updates).toHaveLength(1);
    expect(updates[0].data.status).toBe('confirmed');

    // Exactly one §4.1 ledger row: held → confirmed, same transaction.
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      tenantId: 't1',
      bookingId: 'bk1',
      fromStatus: 'held',
      toStatus: 'confirmed',
    });

    // book evidence (subject = venue) + a metering usage_event.
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      guestId: 'g1',
      subjectType: 'venue',
      subjectRef: 'v1',
      signal: 'book',
    });
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ kind: 'booking', bookingId: 'bk1' });
  });

  it('refuses a provisional guest: confirmed:false, status unchanged, no ledger/evidence/metering', async () => {
    const { svc, ledger, usage, evidence, updates } = make({
      booking: { ...lowRiskBooking, guest: { provisional: true } },
      trustEvents: [{ kind: 'positive', weight: 3 }],
    });

    const res: any = await svc.autoConfirm(ctx, 'bk1');

    expect(res.confirmed).toBe(false);
    expect(res.reason).toMatch(/provisional/);
    expect(updates).toHaveLength(0);
    expect(ledger).toHaveLength(0);
    expect(evidence).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });

  it('refuses a high no-show-risk guest: confirmed:false, status unchanged', async () => {
    const { svc, ledger, updates } = make({
      // non-provisional but 3 prior cancels drives riskScore >= 35.
      booking: { ...lowRiskBooking, inventory: { deposit: null } },
      trustEvents: [],
      priorCancelled: 3,
    });

    const res: any = await svc.autoConfirm(ctx, 'bk1');

    expect(res.confirmed).toBe(false);
    expect(res.riskScore).toBeGreaterThanOrEqual(35);
    expect(res.reason).toMatch(/risk/);
    expect(updates).toHaveLength(0);
    expect(ledger).toHaveLength(0);
  });

  it('is a safe no-op on an already-confirmed booking (no re-transition, no re-metering)', async () => {
    const { svc, ledger, usage, evidence, updates } = make({
      booking: { ...lowRiskBooking, status: 'confirmed' },
    });

    const res: any = await svc.autoConfirm(ctx, 'bk1');

    expect(res.confirmed).toBe(true);
    expect(updates).toHaveLength(0);
    expect(ledger).toHaveLength(0);
    expect(evidence).toHaveLength(0);
    expect(usage).toHaveLength(0);
  });
});
