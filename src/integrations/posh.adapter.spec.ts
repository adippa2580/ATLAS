import { PoshAdapter } from './posh.adapter';
import { createHmac } from 'node:crypto';

/** POSH demand adapter: deterministic stub demand, event normalisation, fail-closed webhook. */
describe('PoshAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new PoshAdapter(config);
  }

  it('returns a deterministic non-empty DemandSignal[] in stub mode', async () => {
    const a = make({});
    const signals = await a.fetchEvents();

    expect(signals.length).toBeGreaterThan(0);
    // Deterministic: a second call yields the same payload.
    expect(await a.fetchEvents()).toEqual(signals);

    for (const s of signals) {
      expect(['event', 'artist']).toContain(s.subjectType);
      expect(typeof s.externalEventId).toBe('string');
      expect(typeof s.demandWeight).toBe('number');
    }
  });

  it('throws in live mode when an API key is configured', async () => {
    const a = make({ 'connectors.poshApiKey': 'key_live' });
    await expect(a.fetchEvents()).rejects.toThrow(
      'POSH live mode not configured in this build',
    );
  });

  it('normalises a POSH-shaped event into a DemandSignal', () => {
    const a = make({});
    const signal = a.normalizeEvent({
      event_id: 'posh_852',
      title: 'Warehouse Social',
      start: '2026-10-01T22:00:00Z',
      rsvp_count: 640,
      city: 'Sydney',
    });

    expect(signal.externalEventId).toBe('posh_852');
    expect(signal.name).toBe('Warehouse Social');
    expect(signal.subjectRef).toBe('Warehouse Social');
    expect(signal.subjectType).toBe('event');
    expect(signal.startsAt).toBe('2026-10-01T22:00:00Z');
    expect(signal.demandWeight).toBe(640);
    expect(signal.venueHint).toBe('Sydney');
  });

  it('is defensive on missing/variant fields (demandWeight defaults to 0)', () => {
    const a = make({});
    const signal = a.normalizeEvent({});

    expect(signal.demandWeight).toBe(0);
    expect(signal.name).toBe('Untitled event');
    expect(signal.subjectType).toBe('event');
  });

  it('trusts webhooks in dev/stub mode with no secret', () => {
    const a = make({ env: 'development' });
    expect(a.verifyWebhook('{}', undefined)).toBe(true);
  });

  it('rejects webhooks in production when no secret is configured', () => {
    const a = make({ env: 'production' });
    expect(a.verifyWebhook('{}', 'sig')).toBe(false);
  });

  it('accepts a correctly signed body and rejects a tampered one', () => {
    const secret = 's3cret';
    const a = make({
      env: 'production',
      'connectors.poshWebhookSecret': secret,
    });
    const body = '{"eventId":"posh_852","converted":true}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });
});
