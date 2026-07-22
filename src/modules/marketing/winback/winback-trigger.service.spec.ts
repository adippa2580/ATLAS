import { WinbackService, WinbackTriggerService } from './winback.module';

/**
 * Lapsed-VIP win-back: computes the tenant's top-spend lapsed cohort and fires
 * one taste-matched Klaviyo send per guest, idempotent per (guest, campaign-day).
 */
describe('WinbackTriggerService', () => {
  const DAY = 86_400_000;
  const daysAgo = (n: number) => new Date(Date.now() - n * DAY);

  // g1: lapsed VIP (last visit 90d ago, spent $1,500) → included.
  // g2: lapsed but low-spend ($100) → excluded (below VIP floor).
  // g3: high-spend but recent (5d ago) → excluded (not lapsed).
  const baseBookings = [
    { guestId: 'g1', date: daysAgo(90), tab: { total: 100_000 } },
    { guestId: 'g1', date: daysAgo(120), tab: { total: 50_000 } },
    { guestId: 'g2', date: daysAgo(90), tab: { total: 10_000 } },
    { guestId: 'g3', date: daysAgo(5), tab: { total: 300_000 } },
  ];

  function make(
    opts: {
      bookings?: any[];
      affinities?: any[];
      idempotency?: any[];
    } = {},
  ) {
    const idempotency: any[] = [...(opts.idempotency ?? [])];
    const prisma: any = {
      booking: { findMany: async () => opts.bookings ?? baseBookings },
      guestAffinity: {
        findMany: async () => opts.affinities ?? [],
      },
      idempotencyRecord: {
        findFirst: async ({ where }: any) =>
          idempotency.find(
            (r) => r.tenantId === where.tenantId && r.key === where.key,
          ) ?? null,
        create: async ({ data }: any) => {
          idempotency.push(data);
          return { id: `i${idempotency.length}`, ...data };
        },
      },
    };
    const klaviyo: any = {
      sendCampaign: jest.fn(async () => ({
        delivered: 1,
        provider: 'klaviyo',
        stub: true,
      })),
    };
    const svc = new WinbackTriggerService(
      prisma,
      klaviyo,
      new WinbackService(prisma),
    );
    return { svc, klaviyo, idempotency };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('sends to lapsed VIPs only — excludes low-spend and non-lapsed guests', async () => {
    const { svc, klaviyo } = make();
    const res = await svc.triggerLapsedVip(ctx, {});

    expect(res.tenantId).toBe('t1');
    expect(res.cohortSize).toBe(1); // only g1
    expect(res.sent).toBe(1);

    // One send, for g1, and never for the excluded guests.
    expect(klaviyo.sendCampaign).toHaveBeenCalledTimes(1);
    const [size, payload] = klaviyo.sendCampaign.mock.calls[0];
    expect(size).toBe(1);
    expect(payload.guestIds).toEqual(['g1']);
    expect(payload.template).toBe('lapsed_vip_winback');
    const allGuests = klaviyo.sendCampaign.mock.calls.flatMap(
      (c: any[]) => c[1].guestIds,
    );
    expect(allGuests).not.toContain('g2');
    expect(allGuests).not.toContain('g3');
  });

  it('references the guest top affinity in the taste-matched send', async () => {
    const { svc, klaviyo } = make({
      affinities: [
        {
          guestId: 'g1',
          subjectType: 'artist',
          subjectRef: 'artist:peggy-gou',
          score: 0.9,
          muted: false,
        },
        {
          guestId: 'g1',
          subjectType: 'artist',
          subjectRef: 'artist:other',
          score: 0.2,
          muted: false,
        },
      ],
    });
    await svc.triggerLapsedVip(ctx, {});
    const [, payload] = klaviyo.sendCampaign.mock.calls[0];
    // Sharpest (highest-score) affinity wins.
    expect(payload.topAffinity.subjectRef).toBe('artist:peggy-gou');
    expect(payload.message).toContain('artist');
  });

  it('is idempotent per (guest, campaign-day): a same-day retry sends nothing new', async () => {
    const { svc, klaviyo, idempotency } = make();

    const first = await svc.triggerLapsedVip(ctx, {});
    expect(first.sent).toBe(1);
    expect(idempotency).toHaveLength(1);

    const second = await svc.triggerLapsedVip(ctx, {});
    expect(second.cohortSize).toBe(1); // still in the cohort
    expect(second.sent).toBe(0); // but not re-sent
    expect(klaviyo.sendCampaign).toHaveBeenCalledTimes(1);
    expect(idempotency).toHaveLength(1);
  });

  it('honours the days override (tighter lapse window widens the cohort)', async () => {
    const { svc } = make();
    // With a 3-day window, g3 (last visit 5d ago) also counts as lapsed and is a
    // VIP ($300k), so the cohort grows to g1 + g3.
    const res = await svc.triggerLapsedVip(ctx, { days: 3 });
    expect(res.cohortSize).toBe(2);
    expect(res.sent).toBe(2);
  });

  it('honours the limit, keeping the top spenders', async () => {
    const { svc, klaviyo } = make();
    const res = await svc.triggerLapsedVip(ctx, { days: 3, limit: 1 });
    expect(res.cohortSize).toBe(1);
    // g3 spent $300k vs g1's $150k → g3 is the top spender kept.
    const [, payload] = klaviyo.sendCampaign.mock.calls[0];
    expect(payload.guestIds).toEqual(['g3']);
  });

  it('returns a zero result when no VIP has lapsed', async () => {
    const { svc, klaviyo } = make({
      bookings: [{ guestId: 'g9', date: daysAgo(1), tab: { total: 500_000 } }],
    });
    const res = await svc.triggerLapsedVip(ctx, {});
    expect(res).toEqual({ tenantId: 't1', cohortSize: 0, sent: 0 });
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });
});
