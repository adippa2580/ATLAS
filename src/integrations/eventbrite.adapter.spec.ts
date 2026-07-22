import { EventbriteAdapter } from './eventbrite.adapter';

/** Eventbrite demand adapter: deterministic stub demand + event normalisation. */
describe('EventbriteAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new EventbriteAdapter(config);
  }

  it('returns a deterministic non-empty DemandSignal[] in stub mode', async () => {
    const a = make({});
    const signals = await a.fetchDemand('venue_1');

    expect(signals.length).toBeGreaterThan(0);
    // Deterministic: a second call yields the same payload.
    expect(await a.fetchDemand('venue_1')).toEqual(signals);

    for (const s of signals) {
      expect(['event', 'artist']).toContain(s.subjectType);
      expect(typeof s.externalEventId).toBe('string');
      expect(typeof s.demandWeight).toBe('number');
    }
    // At least one of each subjectType is represented.
    expect(signals.some((s) => s.subjectType === 'event')).toBe(true);
    expect(signals.some((s) => s.subjectType === 'artist')).toBe(true);
  });

  it('throws in live mode when a token is configured', async () => {
    const a = make({ 'connectors.eventbriteApiToken': 'tok_live' });
    await expect(a.fetchDemand('venue_1')).rejects.toThrow(
      'Eventbrite live mode not configured in this build',
    );
  });

  it('normalises an Eventbrite-shaped event into a DemandSignal', () => {
    const a = make({});
    const signal = a.normalizeEvent({
      id: 'eb_852',
      name: { text: 'Afterlife Presents' },
      start: { utc: '2026-10-01T20:00:00Z' },
      capacity: 950,
      venue: { name: 'The Warehouse' },
    });

    expect(signal.externalEventId).toBe('eb_852');
    expect(signal.name).toBe('Afterlife Presents');
    expect(signal.subjectRef).toBe('Afterlife Presents');
    expect(signal.subjectType).toBe('event');
    expect(signal.startsAt).toBe('2026-10-01T20:00:00Z');
    expect(signal.demandWeight).toBe(950);
    expect(signal.venueHint).toBe('The Warehouse');
  });

  it('is defensive on missing/variant fields (demandWeight defaults to 0)', () => {
    const a = make({});
    const signal = a.normalizeEvent({});

    expect(signal.demandWeight).toBe(0);
    expect(signal.name).toBe('Untitled event');
    expect(signal.subjectType).toBe('event');
  });
});
