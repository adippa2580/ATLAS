import { DiceAdapter } from './dice.adapter';
import { createHmac } from 'node:crypto';

/** DICE ticketing/attendance adapter: stub demand, scan + fail-closed webhook. */
describe('DiceAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new DiceAdapter(config);
  }

  it('returns a deterministic DemandSignal[] in stub mode with an artist-typed event', async () => {
    const a = make({});
    const signals = await a.fetchEvents('venue_1');

    expect(signals.length).toBeGreaterThan(0);
    // Deterministic: a second call yields the same payload.
    expect(await a.fetchEvents('venue_1')).toEqual(signals);

    for (const s of signals) {
      expect(['event', 'artist']).toContain(s.subjectType);
      expect(typeof s.externalEventId).toBe('string');
      expect(typeof s.demandWeight).toBe('number');
    }

    // At least one event maps to an artist subject.
    const artistSignal = signals.find((s) => s.subjectType === 'artist');
    expect(artistSignal).toBeDefined();
    expect(artistSignal?.subjectType).toBe('artist');
  });

  it('throws in live mode when an API key is configured', async () => {
    const a = make({ 'connectors.diceApiKey': 'key_live' });
    await expect(a.fetchEvents('venue_1')).rejects.toThrow(
      'DICE live mode not configured in this build',
    );
  });

  it('normalises an artist lineup into an artist-typed DemandSignal', () => {
    const a = make({});
    const signal = a.normalizeEvent({
      event_id: 'dice_852',
      name: 'Bicep Presents',
      artists: ['Bicep'],
      start_time: '2026-10-01T20:00:00Z',
      allocation: 1200,
      venue: { name: 'The Warehouse' },
    });

    expect(signal.externalEventId).toBe('dice_852');
    expect(signal.subjectType).toBe('artist');
    expect(signal.subjectRef).toBe('Bicep');
    expect(signal.startsAt).toBe('2026-10-01T20:00:00Z');
    expect(signal.demandWeight).toBe(1200);
    expect(signal.venueHint).toBe('The Warehouse');
  });

  it('falls back to an event subject with no artists (demandWeight defaults to 0)', () => {
    const a = make({});
    const signal = a.normalizeEvent({});

    expect(signal.subjectType).toBe('event');
    expect(signal.name).toBe('Untitled event');
    expect(signal.demandWeight).toBe(0);
  });

  it('normalises a scan webhook mapping ticket id and holder contact', () => {
    const a = make({});
    const scan = a.normalizeScan({
      ticket_id: 'tkt_9',
      holder: { email: 'guest@example.com', phone: '+61400000000' },
      scanned_at: '2026-08-15T21:14:00Z',
    });

    expect(scan.externalTicketId).toBe('tkt_9');
    expect(scan.guestEmail).toBe('guest@example.com');
    expect(scan.guestPhone).toBe('+61400000000');
    expect(scan.scannedAt).toBe('2026-08-15T21:14:00Z');
  });

  it('trusts webhooks in dev/stub mode when no secret is configured', () => {
    const a = make({ env: 'development' });
    expect(a.verifyWebhook('{}', undefined)).toBe(true);
  });

  it('accepts a correctly signed body and rejects a tampered one', () => {
    const secret = 's3cret';
    const a = make({
      env: 'production',
      'connectors.diceWebhookSecret': secret,
    });
    const body = '{"ticket_id":"tkt_1"}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });
});
