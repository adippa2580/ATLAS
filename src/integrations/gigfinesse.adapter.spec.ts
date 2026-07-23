import { GigfinesseAdapter } from './gigfinesse.adapter';
import { TalentShortlistItem } from './connector.types';
import { createHmac } from 'node:crypto';

/** GigFinesse adapter: deterministic stub booking execution + fail-closed webhook verification. */
describe('GigfinesseAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    return new GigfinesseAdapter({ get: (k: string) => cfg[k] } as any);
  }

  it('submitShortlist returns accepted = items.length in stub mode', async () => {
    const a = make({});
    const items: TalentShortlistItem[] = [
      { artistRef: 'Sofia Kourtesis', rank: 1, budgetCapCents: 500000 },
      { artistRef: 'DJ Boring', rank: 2, budgetCapCents: 350000 },
    ];
    const res = await a.submitShortlist('venue_1', '2026-09-12', items);

    expect(res.accepted).toBe(items.length);
    expect(typeof res.submissionId).toBe('string');
    // Deterministic: same inputs yield the same submissionId.
    expect(
      (await a.submitShortlist('venue_1', '2026-09-12', items)).submissionId,
    ).toBe(res.submissionId);
  });

  it('submitShortlist throws in live mode when an API key is configured', async () => {
    const a = make({ 'connectors.gigfinesseApiKey': 'key_live' });
    await expect(
      a.submitShortlist('venue_1', '2026-09-12', []),
    ).rejects.toThrow('GigFinesse live mode not configured in this build');
  });

  it('fetchConfirmed returns deterministic rows with integer feeCents and confirmed status', async () => {
    const a = make({});
    const rows = await a.fetchConfirmed('venue_1');

    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(await a.fetchConfirmed('venue_1')).toEqual(rows);

    for (const row of rows) {
      expect(Number.isInteger(row.feeCents)).toBe(true);
      expect(row.feeCents).toBeGreaterThan(0);
      expect(row.status).toBe('confirmed');
      expect(typeof row.externalBookingId).toBe('string');
    }
  });

  it('fetchConfirmed throws in live mode when an API key is configured', async () => {
    const a = make({ 'connectors.gigfinesseApiKey': 'key_live' });
    await expect(a.fetchConfirmed('venue_1')).rejects.toThrow(
      'GigFinesse live mode not configured in this build',
    );
  });

  it('normalizeConfirmed maps a GigFinesse-shaped payload into integer cents', () => {
    const a = make({});
    const event = a.normalizeConfirmed({
      booking_id: 'gf_852',
      artist: 'Anz',
      fee_cents: 610000,
      date: '2026-09-26T22:30:00Z',
      status: 'confirmed',
      venue: 'Brisbane',
    });

    expect(event.externalBookingId).toBe('gf_852');
    expect(event.artistRef).toBe('Anz');
    expect(event.feeCents).toBe(610000);
    expect(Number.isInteger(event.feeCents)).toBe(true);
    expect(event.date).toBe('2026-09-26T22:30:00Z');
    expect(event.status).toBe('confirmed');
    expect(event.venueHint).toBe('Brisbane');
  });

  it('normalizeConfirmed handles field-name variants (id/artist_name/starts_at/feeDollars)', () => {
    const a = make({});
    const event = a.normalizeConfirmed({
      id: 'alt_99',
      artist_name: 'Sofia Kourtesis',
      feeDollars: 4500.5,
      starts_at: '2026-09-12T21:00:00Z',
      status: 'offered',
    });

    expect(event.externalBookingId).toBe('alt_99');
    expect(event.artistRef).toBe('Sofia Kourtesis');
    // Dollars → integer cents, no floats: 4500.5 * 100 = 450050.
    expect(event.feeCents).toBe(450050);
    expect(Number.isInteger(event.feeCents)).toBe(true);
    expect(event.date).toBe('2026-09-12T21:00:00Z');
    expect(event.status).toBe('offered');
  });

  it('verifyWebhook trusts webhooks in dev/stub mode when the secret is unset', () => {
    const a = make({ env: 'development' });
    expect(a.verifyWebhook('{}', undefined)).toBe(true);
  });

  it('verifyWebhook accepts a correctly signed body and rejects a tampered one when the secret is set', () => {
    const secret = 'gf_s3cret';
    const a = make({
      env: 'production',
      'connectors.gigfinesseWebhookSecret': secret,
    });
    const body = '{"booking_id":"b1","fee_cents":610000}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body, 'deadbeef')).toBe(false);
  });
});
