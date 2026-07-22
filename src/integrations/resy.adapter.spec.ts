import { ResyAdapter } from './resy.adapter';
import { createHmac } from 'node:crypto';

/** Resy adapter: fail-closed webhook verification + reservation normalisation. */
describe('ResyAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new ResyAdapter(config);
  }

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
      'connectors.resyWebhookSecret': secret,
    });
    const body = '{"reservation_id":"r1","num_seats":4}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });

  it('normalises a Resy-shaped body into ReservationPayload', () => {
    const a = make({});
    const res = a.normalizeReservation({
      resy_token: 'rt_9',
      num_seats: 5,
      day: '2026-08-01',
      time: '20:30:00',
      table: 'C7',
      status: 'CHECKED_IN',
      first_name: 'Lena',
      last_name: 'Ortiz',
      phone: '+14155550199',
      email: 'lena@example.com',
      min_spend: 4200.4,
    });
    expect(res.externalReservationId).toBe('rt_9');
    expect(res.partySize).toBe(5);
    expect(res.date).toBe('2026-08-01T20:30:00');
    expect(res.tableRef).toBe('C7');
    expect(res.status).toBe('seated');
    expect(res.guestName).toBe('Lena Ortiz');
    expect(res.guestPhone).toBe('+14155550199');
    expect(res.guestEmail).toBe('lena@example.com');
    expect(res.minSpendCents).toBe(4200);
  });

  it('maps cancellation/no-show statuses and defaults to booked', () => {
    const a = make({});
    expect(a.normalizeReservation({ status: 'CANCELED' }).status).toBe(
      'cancelled',
    );
    expect(a.normalizeReservation({ status: 'no-show' }).status).toBe(
      'no_show',
    );
    expect(a.normalizeReservation({}).status).toBe('booked');
  });

  it('omits minSpendCents when the reservation carries no minimum', () => {
    const a = make({});
    const res = a.normalizeReservation({ reservation_id: 'r2', party_size: 2 });
    expect(res.minSpendCents).toBeUndefined();
    expect(res.partySize).toBe(2);
  });

  it('returns a deterministic stub set from fetchReservations', async () => {
    const a = make({});
    const rows = await a.fetchReservations('venue_1');
    const again = await a.fetchReservations('venue_1');
    expect(rows).toEqual(again);
    expect(rows).toHaveLength(3);
    expect(rows[0].externalReservationId).toBe('resy_res_1001');
    expect(rows.every((r) => typeof r.partySize === 'number')).toBe(true);
  });

  it('throws in live mode (api key configured)', async () => {
    const a = make({ 'connectors.resyApiKey': 'live-key' });
    await expect(a.fetchReservations('venue_1')).rejects.toThrow(
      'Resy live mode not configured in this build',
    );
  });
});
