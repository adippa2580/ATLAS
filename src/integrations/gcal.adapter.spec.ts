import { GoogleCalendarAdapter } from './gcal.adapter';

/** Google Calendar adapter: stub/live authorizeUrl + deterministic event feed + normalisation. */
describe('GoogleCalendarAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new GoogleCalendarAdapter(config);
  }

  it('returns a stub authorize URL when no client id is configured', () => {
    const a = make({});
    expect(a.authorizeUrl('xyz')).toBe(
      'https://stub.local/gcal/authorize?state=xyz',
    );
  });

  it('returns a Google OAuth consent URL when a client id is set', () => {
    const a = make({ 'connectors.googleCalendarClientId': 'cid123' });
    const url = a.authorizeUrl('st8');
    expect(url).toContain('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url).toContain('client_id=cid123');
    expect(url).toContain('state=st8');
    expect(url).toContain('calendar.readonly');
  });

  it('fetchEvents stub returns a deterministic non-empty DemandSignal[]', async () => {
    const a = make({});
    const events = await a.fetchEvents('tok');
    expect(events.length).toBeGreaterThan(0);
    expect(events).toEqual(await a.fetchEvents('tok'));
    for (const e of events) {
      expect(e.subjectType).toBe('event');
      expect(typeof e.externalEventId).toBe('string');
      expect(typeof e.demandWeight).toBe('number');
    }
  });

  it('throws in live mode (not configured in this build)', async () => {
    const a = make({ 'connectors.googleCalendarClientId': 'cid123' });
    await expect(a.fetchEvents('tok')).rejects.toThrow(
      'Google Calendar live mode not configured in this build',
    );
  });

  it('normalises a GCal-shaped event into a DemandSignal', () => {
    const a = make({});
    const signal = a.normalizeEvent({
      id: 'abc123',
      summary: 'Warehouse Rave',
      start: { dateTime: '2026-09-01T22:00:00.000Z' },
      location: 'Alexandria',
      attendees: [
        { email: 'a@x.com' },
        { email: 'b@x.com' },
        { email: 'c@x.com' },
      ],
    });
    expect(signal.externalEventId).toBe('abc123');
    expect(signal.subjectRef).toBe('Warehouse Rave');
    expect(signal.subjectType).toBe('event');
    expect(signal.startsAt).toBe('2026-09-01T22:00:00.000Z');
    expect(signal.demandWeight).toBe(3);
    expect(signal.venueHint).toBe('Alexandria');
  });

  it('defaults demandWeight to 1 and handles all-day (date-only) events', () => {
    const a = make({});
    const signal = a.normalizeEvent({
      eventId: 'day1',
      title: 'All-Day Popup',
      start: { date: '2026-09-15' },
    });
    expect(signal.externalEventId).toBe('day1');
    expect(signal.subjectRef).toBe('All-Day Popup');
    expect(signal.startsAt).toBe('2026-09-15');
    expect(signal.demandWeight).toBe(1);
    expect(signal.venueHint).toBeUndefined();
  });
});
