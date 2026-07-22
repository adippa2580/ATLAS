import {
  EventOffersService,
  LEAD_MAX_DAYS,
  LEAD_MIN_DAYS,
} from './event-offers.module';

/**
 * "Time offers to arena shows" (planning endpoint). Hand-rolled Prisma stub
 * (closeout.service.spec style): fixtures for the global Entity event catalog,
 * tenant-scoped GuestAffinity, and Guest name lookups.
 */
describe('EventOffersService', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const ctx = { tenantId: 't1', scopes: [] } as any;

  function iso(daysFromNow: number) {
    return new Date(Date.now() + daysFromNow * DAY_MS).toISOString();
  }

  function make(opts: { events?: any[]; affinities?: any[]; guests?: any[] }) {
    const calls = { affinityWhere: [] as any[], guestWhere: [] as any[] };
    const prisma: any = {
      entity: {
        findMany: async ({ where }: any) => {
          expect(where.kind).toBe('event');
          return opts.events ?? [];
        },
      },
      guestAffinity: {
        findMany: async ({ where }: any) => {
          calls.affinityWhere.push(where);
          const refs: string[] = where.subjectRef?.in ?? [];
          return (opts.affinities ?? []).filter(
            (a) =>
              a.tenantId === where.tenantId &&
              !a.muted &&
              refs.includes(a.subjectRef),
          );
        },
      },
      guest: {
        findMany: async ({ where }: any) => {
          calls.guestWhere.push(where);
          const ids: string[] = where.id?.in ?? [];
          return (opts.guests ?? []).filter(
            (g) => g.tenantId === where.tenantId && ids.includes(g.id),
          );
        },
      },
    };
    return { svc: new EventOffersService(prisma), calls };
  }

  // Two upcoming events; e-hot has aligned-affinity guests, e-cold has none.
  const events = [
    {
      id: 'e-hot',
      kind: 'event',
      name: 'Arena Show A',
      metadata: { date: null, artistIds: ['artist-1'] },
    },
    {
      id: 'e-cold',
      kind: 'event',
      name: 'Arena Show B',
      metadata: { date: null, artistIds: ['artist-9'] },
    },
  ];

  const affinities = [
    // Direct event affinity + lineup-artist affinity → both land on e-hot.
    {
      tenantId: 't1',
      guestId: 'g1',
      subjectType: 'event',
      subjectRef: 'e-hot',
      score: 0.8,
      muted: false,
    },
    {
      tenantId: 't1',
      guestId: 'g1',
      subjectType: 'artist',
      subjectRef: 'artist-1',
      score: 0.5,
      muted: false,
    },
    {
      tenantId: 't1',
      guestId: 'g2',
      subjectType: 'artist',
      subjectRef: 'artist-1',
      score: 0.6,
      muted: false,
    },
    // Muted + other-tenant rows must never match.
    {
      tenantId: 't1',
      guestId: 'g3',
      subjectType: 'event',
      subjectRef: 'e-hot',
      score: 0.9,
      muted: true,
    },
    {
      tenantId: 't2',
      guestId: 'gX',
      subjectType: 'event',
      subjectRef: 'e-hot',
      score: 0.9,
      muted: false,
    },
  ];

  const guests = [
    { id: 'g1', tenantId: 't1', displayName: 'Ada' },
    { id: 'g2', tenantId: 't1', displayName: 'Bao' },
  ];

  it('ranks an event with aligned-affinity guests above one with none', async () => {
    const { svc } = make({ events, affinities, guests });
    const res = await svc.eventTimedOffers(ctx);

    expect(res.schedule.map((s) => s.eventId)).toEqual(['e-hot', 'e-cold']);
    const hot = res.schedule[0];
    const cold = res.schedule[1];
    expect(hot.matchedGuests).toBe(2); // g1, g2 (muted g3 + tenant-t2 excluded)
    expect(cold.matchedGuests).toBe(0);
    expect(cold.topGuests).toEqual([]);
  });

  it('combines a guest event + lineup-artist affinity into one summed score', async () => {
    const { svc } = make({ events, affinities, guests });
    const res = await svc.eventTimedOffers(ctx);
    const hot = res.schedule[0];

    // g1: 0.8 (event) + 0.5 (artist-1) = 1.3 outranks g2: 0.6 (artist only).
    expect(hot.topGuests[0]).toEqual({
      guestId: 'g1',
      displayName: 'Ada',
      affinityScore: expect.closeTo(1.3, 5),
    });
    expect(hot.topGuests[1].guestId).toBe('g2');
    expect(hot.topGuests[1].affinityScore).toBeCloseTo(0.6, 5);
  });

  it('excludes muted and cross-tenant affinities via tenant-scoped queries', async () => {
    const { svc, calls } = make({ events, affinities, guests });
    await svc.eventTimedOffers(ctx);

    for (const w of calls.affinityWhere) expect(w.tenantId).toBe('t1');
    for (const w of calls.guestWhere) expect(w.tenantId).toBe('t1');
    // g3 is muted, gX is tenant t2 — neither should surface anywhere.
    const flat = JSON.stringify((await svc.eventTimedOffers(ctx)).schedule);
    expect(flat).not.toContain('g3');
    expect(flat).not.toContain('gX');
  });

  it('filters dated events outside the withinDays horizon but keeps undated candidates', async () => {
    const dated = [
      {
        id: 'e-soon',
        kind: 'event',
        name: 'Soon',
        metadata: { date: iso(5), artistIds: ['artist-1'] },
      },
      {
        id: 'e-far',
        kind: 'event',
        name: 'Far',
        metadata: { date: iso(90), artistIds: ['artist-1'] },
      },
      {
        id: 'e-past',
        kind: 'event',
        name: 'Past',
        metadata: { date: iso(-10), artistIds: ['artist-1'] },
      },
      { id: 'e-undated', kind: 'event', name: 'Undated', metadata: {} },
    ];
    const { svc } = make({ events: dated, affinities, guests });
    const res = await svc.eventTimedOffers(ctx, 30);

    const ids = res.schedule.map((s) => s.eventId).sort();
    // e-far (>30d) and e-past (already happened) dropped; undated kept.
    expect(ids).toEqual(['e-soon', 'e-undated']);
    expect(res.withinDays).toBe(30);
  });

  it('derives a pre-event send window from a dated event and marks undated ones', async () => {
    const dated = [
      {
        id: 'e-soon',
        kind: 'event',
        name: 'Soon',
        metadata: { startsAt: iso(20) },
      },
      { id: 'e-undated', kind: 'event', name: 'Undated', metadata: {} },
    ];
    const { svc } = make({ events: dated, affinities, guests });
    const res = await svc.eventTimedOffers(ctx);

    const soon = res.schedule.find((s) => s.eventId === 'e-soon')!;
    const win = soon.suggestedSendWindow as any;
    expect(win.basis).toBe('event-date');
    const eventTime = Date.parse(soon.eventDate!);
    expect(Date.parse(win.start)).toBeCloseTo(
      eventTime - LEAD_MAX_DAYS * DAY_MS,
      -3,
    );
    expect(Date.parse(win.end)).toBeCloseTo(
      eventTime - LEAD_MIN_DAYS * DAY_MS,
      -3,
    );

    const undated = res.schedule.find((s) => s.eventId === 'e-undated')!;
    expect(undated.suggestedSendWindow).toEqual({
      start: null,
      end: null,
      basis: 'undated',
    });
  });

  it('returns an empty schedule (no throw) when the catalog has no events', async () => {
    const { svc } = make({ events: [] });
    const res = await svc.eventTimedOffers(ctx);
    expect(res.schedule).toEqual([]);
    expect(res.feature).toBe('event-timed-offers');
  });
});
