import { ResidentAdvisorAdapter } from './residentadvisor.adapter';
import { DemandSignal } from './connector.types';

/** Resident Advisor demand adapter: deterministic stub, normalise, dedupe. */
describe('ResidentAdvisorAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new ResidentAdvisorAdapter(config);
  }

  it('returns a deterministic non-empty DemandSignal[] in stub mode', async () => {
    const a = make({});
    const signals = await a.fetchEvents('Berlin');

    expect(signals.length).toBeGreaterThan(0);
    // Deterministic: a second call yields the same payload.
    expect(await a.fetchEvents('Berlin')).toEqual(signals);

    for (const s of signals) {
      expect(['event', 'artist']).toContain(s.subjectType);
      expect(typeof s.externalEventId).toBe('string');
      expect(typeof s.demandWeight).toBe('number');
      expect(s.venueHint).toBe('Berlin');
    }
    // Both electronic events and headline artists are represented.
    expect(signals.some((s) => s.subjectType === 'event')).toBe(true);
    expect(signals.some((s) => s.subjectType === 'artist')).toBe(true);
  });

  it('throws in live mode when an api key is configured', async () => {
    const a = make({ 'connectors.residentAdvisorApiKey': 'ra_live' });
    await expect(a.fetchEvents('Berlin')).rejects.toThrow(
      'Resident Advisor live mode not configured in this build',
    );
  });

  it('normalises an RA-shaped event (artists[] → artist subjectRef)', () => {
    const a = make({});
    const signal = a.normalizeEvent({
      id: 'ra_852',
      title: 'EXHALE w/ Amelie Lens',
      artists: [{ name: 'Amelie Lens' }, { name: 'Farrago' }],
      startTime: '2026-10-01T22:00:00Z',
      interestedCount: 3100,
      venue: { name: 'Printworks' },
    });

    expect(signal.externalEventId).toBe('ra_852');
    expect(signal.name).toBe('EXHALE w/ Amelie Lens');
    expect(signal.subjectType).toBe('artist');
    expect(signal.subjectRef).toBe('Amelie Lens');
    expect(signal.startsAt).toBe('2026-10-01T22:00:00Z');
    expect(signal.demandWeight).toBe(3100);
    expect(signal.venueHint).toBe('Printworks');
  });

  it('is defensive on missing/variant fields (no artists → event, weight 0)', () => {
    const a = make({});
    const signal = a.normalizeEvent({});

    expect(signal.demandWeight).toBe(0);
    expect(signal.name).toBe('Untitled event');
    expect(signal.subjectType).toBe('event');
    expect(signal.subjectRef).toBe('Untitled event');
    expect(signal.startsAt).toBeUndefined();
    expect(signal.venueHint).toBeUndefined();
  });

  it('dedupe collapses same day+venue+subject, keeping the higher demandWeight', () => {
    const a = make({});
    const ra: DemandSignal = {
      externalEventId: 'ra_1',
      name: 'Ben Klock at Berghain',
      subjectType: 'artist',
      subjectRef: 'Ben Klock',
      startsAt: '2026-08-15T23:00:00.000Z',
      demandWeight: 2400,
      venueHint: 'Berghain',
    };
    // Same show off the Ticketmaster feed: same day+venue+subject, hotter count.
    const tm: DemandSignal = {
      externalEventId: 'tm_9',
      name: 'Ben Klock — Berlin',
      subjectType: 'artist',
      subjectRef: 'Ben Klock',
      startsAt: '2026-08-15T21:00:00.000Z',
      demandWeight: 3000,
      venueHint: 'Berghain',
    };
    // A genuinely different show that must survive.
    const other: DemandSignal = {
      externalEventId: 'ra_2',
      name: 'Amelie Lens presents EXHALE',
      subjectType: 'artist',
      subjectRef: 'Amelie Lens',
      startsAt: '2026-08-22T22:00:00.000Z',
      demandWeight: 1800,
      venueHint: 'Printworks',
    };

    expect(a.dedupeKey(ra)).toBe(a.dedupeKey(tm));

    const out = a.dedupe([ra, tm, other]);
    expect(out).toHaveLength(2);
    const klock = out.find((s) => s.subjectRef === 'Ben Klock');
    expect(klock?.externalEventId).toBe('tm_9');
    expect(klock?.demandWeight).toBe(3000);
    expect(out.some((s) => s.subjectRef === 'Amelie Lens')).toBe(true);
  });
});
