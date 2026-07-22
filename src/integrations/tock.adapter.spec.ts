import { TockAdapter } from './tock.adapter';
import { createHmac } from 'node:crypto';

/** Tock adapter: fail-closed webhook verification + reservation normalisation. */
describe('TockAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new TockAdapter(config);
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
      'connectors.tockWebhookSecret': secret,
    });
    const body = '{"bookingId":"b1","partySize":2}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });

  it('normalises a Tock-shaped booking body into ReservationPayload', () => {
    const a = make({});
    const res = a.normalizeReservation({
      bookingId: 'b9',
      diner: {
        name: 'Jordan Lee',
        phone: '+61411222333',
        email: 'jordan@example.com',
      },
      guests: 3,
      experienceDatetime: '2026-08-01T18:30:00.000Z',
      experienceRef: 'omakase',
      status: 'ARRIVED',
      prepaidAmount: 18000.4,
    });
    expect(res.externalReservationId).toBe('b9');
    expect(res.guestName).toBe('Jordan Lee');
    expect(res.guestPhone).toBe('+61411222333');
    expect(res.guestEmail).toBe('jordan@example.com');
    expect(res.partySize).toBe(3);
    expect(res.date).toBe('2026-08-01T18:30:00.000Z');
    expect(res.tableRef).toBe('omakase');
    expect(res.status).toBe('seated');
    expect(res.minSpendCents).toBe(18000);
  });

  it('maps cancellation and no-show statuses, omitting empty prepaid', () => {
    const a = make({});
    const cancelled = a.normalizeReservation({
      id: 'c1',
      partySize: 2,
      status: 'canceled',
    });
    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.minSpendCents).toBeUndefined();

    const noShow = a.normalizeReservation({ id: 'n1', status: 'NO_SHOW' });
    expect(noShow.status).toBe('no_show');
  });

  it('returns deterministic stub reservations when unconfigured', async () => {
    const a = make({});
    const rows = await a.fetchReservations('venue_1');
    expect(rows).toHaveLength(3);
    expect(rows[0].externalReservationId).toBe('tock_res_1001');
    expect(rows[0].minSpendCents).toBe(24000);
    expect(rows[1].status).toBe('seated');
    expect(rows[2].status).toBe('cancelled');
    expect(rows[2].minSpendCents).toBeUndefined();
    // deterministic across calls
    expect(await a.fetchReservations('venue_1')).toEqual(rows);
  });

  it('throws in live mode', async () => {
    const a = make({ 'connectors.tockApiKey': 'live_key' });
    await expect(a.fetchReservations('venue_1')).rejects.toThrow(
      'Tock live mode not configured in this build',
    );
  });
});
