import { CrewRebookService } from './crew-rebook.module';

/**
 * Crew re-booking nudges: a lapsed crew (qualifying past visit older than
 * sinceDays) with nothing upcoming gets one nudge; a crew with a future booking
 * is excluded; same-day runs are idempotent per (crew, day).
 */
describe('CrewRebookService', () => {
  const DAY = 86_400_000;
  const now = Date.now();
  const daysAgo = (d: number) => new Date(now - d * DAY);
  const daysAhead = (d: number) => new Date(now + d * DAY);

  function make(opts: {
    bookings: any[];
    members?: any[];
    /** Pre-seeded idempotency keys (simulating an earlier same-day run). */
    seededKeys?: string[];
  }) {
    const ledger: any[] = [...(opts.seededKeys ?? []).map((key) => ({ key }))];
    const prisma: any = {
      booking: { findMany: async () => opts.bookings },
      crewMember: {
        findMany: async ({ where }: any) =>
          (opts.members ?? []).filter((m) =>
            where.crewId.in.includes(m.crewId),
          ),
      },
      idempotencyRecord: {
        findFirst: async ({ where }: any) =>
          ledger.find((r) => r.key === where.key) ?? null,
        create: async ({ data }: any) => {
          ledger.push(data);
          return { id: `i${ledger.length}`, ...data };
        },
      },
    };
    const klaviyo: any = {
      sendCampaign: jest.fn(async (size: number) => ({ delivered: size })),
    };
    return {
      svc: new CrewRebookService(prisma, klaviyo),
      klaviyo,
      ledger,
    };
  }

  const ctx = { tenantId: 't1', scopes: [] } as any;

  it('nudges a lapsed crew with a qualifying past visit and nothing upcoming', async () => {
    const { svc, klaviyo } = make({
      bookings: [
        { crewId: 'c1', status: 'closed', date: daysAgo(90) },
        { crewId: 'c1', status: 'seated', date: daysAgo(120) },
      ],
      members: [
        { crewId: 'c1', guestId: 'g1' },
        { crewId: 'c1', guestId: 'g2' },
      ],
    });

    const res = await svc.nudgeLapsedCrews(ctx, {});

    expect(res).toEqual({ tenantId: 't1', crewsNudged: 1, sent: 2 });
    expect(klaviyo.sendCampaign).toHaveBeenCalledTimes(1);
    const [size, payload] = klaviyo.sendCampaign.mock.calls[0];
    expect(size).toBe(2);
    expect(payload.template).toBe('crew_rebook_nudge');
    expect(payload.crewId).toBe('c1');
    expect(payload.guestIds).toEqual(['g1', 'g2']);
  });

  it('excludes a crew that has a future booking', async () => {
    const { svc, klaviyo } = make({
      bookings: [
        { crewId: 'c1', status: 'closed', date: daysAgo(90) },
        { crewId: 'c1', status: 'confirmed', date: daysAhead(7) },
      ],
      members: [{ crewId: 'c1', guestId: 'g1' }],
    });

    const res = await svc.nudgeLapsedCrews(ctx, {});

    expect(res).toEqual({ tenantId: 't1', crewsNudged: 0, sent: 0 });
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });

  it('excludes a crew whose most recent visit is within the lapse window', async () => {
    const { svc, klaviyo } = make({
      bookings: [{ crewId: 'c1', status: 'closed', date: daysAgo(10) }],
      members: [{ crewId: 'c1', guestId: 'g1' }],
    });

    const res = await svc.nudgeLapsedCrews(ctx, {});

    expect(res.crewsNudged).toBe(0);
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });

  it('ignores crews with no qualifying (seated/closed) past visit', async () => {
    const { svc, klaviyo } = make({
      bookings: [
        { crewId: 'c1', status: 'held', date: daysAgo(90) },
        { crewId: 'c1', status: 'cancelled', date: daysAgo(90) },
      ],
      members: [{ crewId: 'c1', guestId: 'g1' }],
    });

    const res = await svc.nudgeLapsedCrews(ctx, {});

    expect(res.crewsNudged).toBe(0);
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });

  it('is idempotent per (crew, day): a same-day re-run does not re-nudge', async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { svc, klaviyo } = make({
      bookings: [{ crewId: 'c1', status: 'closed', date: daysAgo(90) }],
      members: [{ crewId: 'c1', guestId: 'g1' }],
      seededKeys: [`crew-rebook:c1:${day}`],
    });

    const res = await svc.nudgeLapsedCrews(ctx, {});

    expect(res).toEqual({ tenantId: 't1', crewsNudged: 0, sent: 0 });
    expect(klaviyo.sendCampaign).not.toHaveBeenCalled();
  });

  it('writes a ledger record so a second run in the same process is a no-op', async () => {
    const { svc, klaviyo, ledger } = make({
      bookings: [{ crewId: 'c1', status: 'closed', date: daysAgo(90) }],
      members: [{ crewId: 'c1', guestId: 'g1' }],
    });

    const first = await svc.nudgeLapsedCrews(ctx, {});
    expect(first.crewsNudged).toBe(1);
    expect(ledger).toHaveLength(1);
    expect(ledger[0].key).toContain('crew-rebook:c1:');

    const second = await svc.nudgeLapsedCrews(ctx, {});
    expect(second.crewsNudged).toBe(0);
    expect(klaviyo.sendCampaign).toHaveBeenCalledTimes(1);
  });

  it('respects a custom sinceDays window', async () => {
    // A 30-day-old visit is lapsed under sinceDays=20 but not under default 45.
    const bookings = [{ crewId: 'c1', status: 'closed', date: daysAgo(30) }];
    const members = [{ crewId: 'c1', guestId: 'g1' }];

    const wide = make({ bookings, members });
    expect((await wide.svc.nudgeLapsedCrews(ctx, {})).crewsNudged).toBe(0);

    const narrow = make({ bookings, members });
    expect(
      (await narrow.svc.nudgeLapsedCrews(ctx, { sinceDays: 20 })).crewsNudged,
    ).toBe(1);
  });
});
