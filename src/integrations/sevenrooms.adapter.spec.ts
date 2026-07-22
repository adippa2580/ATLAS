import { SevenroomsAdapter } from './sevenrooms.adapter';
import { createHmac } from 'node:crypto';

/** SevenRooms adapter: fail-closed webhook verification + reservation normalisation. */
describe('SevenroomsAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new SevenroomsAdapter(config);
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
      'connectors.sevenroomsWebhookSecret': secret,
    });
    const body = '{"reservation_id":"r1","party_size":4}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });

  it('normalises a SevenRooms-shaped body into ReservationPayload', () => {
    const a = make({});
    const res = a.normalizeReservation({
      reservation_id: 'r9',
      guest_name: 'Jane Doe',
      guest_phone: '+61400999888',
      guest_email: 'jane@example.com',
      party_size: 5,
      arrival_time: '2026-08-01T18:30:00.000Z',
      table: 'A7',
      status: 'NO_SHOW',
      minimum_spend: 25000.6,
    });
    expect(res.externalReservationId).toBe('r9');
    expect(res.guestName).toBe('Jane Doe');
    expect(res.guestPhone).toBe('+61400999888');
    expect(res.guestEmail).toBe('jane@example.com');
    expect(res.partySize).toBe(5);
    expect(res.date).toBe('2026-08-01T18:30:00.000Z');
    expect(res.tableRef).toBe('A7');
    expect(res.status).toBe('no_show');
    expect(res.minSpendCents).toBe(25001);
    expect(Number.isInteger(res.minSpendCents)).toBe(true);
  });

  it('normalises status variants and joins first/last name', () => {
    const a = make({});
    expect(a.normalizeReservation({ status: 'SEATED' }).status).toBe('seated');
    expect(a.normalizeReservation({ status: 'CANCELLED' }).status).toBe(
      'cancelled',
    );
    expect(a.normalizeReservation({ status: 'BOOKED' }).status).toBe('booked');
    expect(a.normalizeReservation({ status: undefined }).status).toBe('booked');
    const named = a.normalizeReservation({
      first_name: 'Sam',
      last_name: 'Lee',
    });
    expect(named.guestName).toBe('Sam Lee');
    // No minimum spend provided → field omitted.
    expect(named.minSpendCents).toBeUndefined();
  });

  it('returns deterministic stub reservations in stub mode', async () => {
    const a = make({});
    const rows = await a.fetchReservations('venue_1');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].externalReservationId).toBe('sr_res_1001');
    expect(rows[0].status).toBe('booked');
    expect(rows[0].minSpendCents).toBe(40000);
    // Deterministic across calls.
    const rows2 = await a.fetchReservations('venue_1');
    expect(rows2).toEqual(rows);
  });

  it('throws in live mode (api key configured)', async () => {
    const a = make({ 'connectors.sevenroomsApiKey': 'live-key' });
    await expect(a.fetchReservations('venue_1')).rejects.toThrow(
      'SevenRooms live mode not configured in this build',
    );
  });
});
