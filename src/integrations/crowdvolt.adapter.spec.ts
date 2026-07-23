import { CrowdvoltAdapter } from './crowdvolt.adapter';
import { createHmac } from 'node:crypto';

/** CrowdVolt resale adapter: deterministic stub demand, resale normalisation,
 * fail-closed webhook verification. */
describe('CrowdvoltAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new CrowdvoltAdapter(config);
  }

  it('returns a deterministic non-empty ResaleSignal[] in stub mode', async () => {
    const a = make({});
    const signals = await a.fetchResaleDemand();

    expect(signals.length).toBeGreaterThan(0);
    // Deterministic: a second call yields the same payload.
    expect(await a.fetchResaleDemand()).toEqual(signals);

    for (const s of signals) {
      expect(typeof s.externalEventId).toBe('string');
      expect(typeof s.eventName).toBe('string');
      expect(typeof s.resaleVolume).toBe('number');
      expect(typeof s.pricePressure).toBe('number');
      expect(s.soldOut).toBe(true);
    }
  });

  it('throws in live mode when an API key is configured', async () => {
    const a = make({ 'connectors.crowdvoltApiKey': 'key_live' });
    await expect(a.fetchResaleDemand(['cv_1'])).rejects.toThrow(
      'CrowdVolt live mode not configured in this build',
    );
  });

  it('normalises a CrowdVolt-shaped listing and computes pricePressure = resale/face', () => {
    const a = make({});
    const signal = a.normalizeListing({
      id: 'cv_852',
      event: 'Peggy Gou Live',
      active_listings: 300,
      resale_price: 140,
      face_value: 100,
      sold_out: true,
      starts_at: '2026-10-01T20:00:00Z',
      venue: 'The Warehouse',
    });

    expect(signal.externalEventId).toBe('cv_852');
    expect(signal.eventName).toBe('Peggy Gou Live');
    expect(signal.subjectRef).toBe('Peggy Gou Live');
    expect(signal.resaleVolume).toBe(300);
    expect(signal.pricePressure).toBeCloseTo(1.4);
    expect(signal.soldOut).toBe(true);
    expect(signal.startsAt).toBe('2026-10-01T20:00:00Z');
    expect(signal.venueHint).toBe('The Warehouse');
  });

  it('defaults pricePressure to 1 when face value is missing or zero (divide-by-zero guarded)', () => {
    const a = make({});

    const missingFace = a.normalizeListing({ resale_price: 140 });
    expect(missingFace.pricePressure).toBe(1);

    const zeroFace = a.normalizeListing({ resale_price: 140, face_value: 0 });
    expect(zeroFace.pricePressure).toBe(1);
  });

  it('is defensive on missing/variant fields (resaleVolume defaults to 0)', () => {
    const a = make({});
    const signal = a.normalizeListing({});

    expect(signal.resaleVolume).toBe(0);
    expect(signal.eventName).toBe('Untitled event');
    expect(signal.pricePressure).toBe(1);
    expect(signal.soldOut).toBe(false);
  });

  it('rejects webhooks in production when no secret is configured', () => {
    const a = make({ env: 'production' });
    expect(a.verifyWebhook('{}', 'sig')).toBe(false);
  });

  it('trusts webhooks in dev/stub mode with no secret', () => {
    const a = make({ env: 'development' });
    expect(a.verifyWebhook('{}', undefined)).toBe(true);
  });

  it('accepts a correctly signed body and rejects a tampered one', () => {
    const secret = 's3cret';
    const a = make({
      env: 'production',
      'connectors.crowdvoltWebhookSecret': secret,
    });
    const body = '{"event_id":"cv_1","listings":42}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });
});
