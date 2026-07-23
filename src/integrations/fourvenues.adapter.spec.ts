import { FourvenuesAdapter } from './fourvenues.adapter';
import { createHmac } from 'node:crypto';

/** Fourvenues adapter (KAN-6): stub feeds, event/attendance normalisation, fail-closed webhooks. */
describe('FourvenuesAdapter', () => {
  function make(cfg: Record<string, string | undefined>) {
    const config: any = { get: (k: string) => cfg[k] };
    return new FourvenuesAdapter(config);
  }

  it('returns deterministic stub events in stub mode', async () => {
    const a = make({});
    const rows = await a.fetchEvents('venue_1');
    expect(rows.length).toBe(3);
    expect(rows[0].externalEventId).toBe('fv_evt_201');
    expect(rows[0].subjectType).toBe('event');
    expect(rows[2].subjectType).toBe('artist');
    // Deterministic across calls.
    const rows2 = await a.fetchEvents('venue_1');
    expect(rows2).toEqual(rows);
  });

  it('throws in live mode for fetchEvents (api key configured)', async () => {
    const a = make({ 'connectors.fourvenuesApiKey': 'live-key' });
    await expect(a.fetchEvents('venue_1')).rejects.toThrow(
      'Fourvenues live mode not configured in this build',
    );
  });

  it('returns deterministic stub guest-list entries as ReservationPayload', async () => {
    const a = make({});
    const rows = await a.fetchGuestList('fv_evt_201');
    expect(rows.length).toBeGreaterThanOrEqual(2);
    expect(rows[0].externalReservationId).toBe('fv_gl_3001');
    expect(rows[0].status).toBe('booked');
    expect(rows[1].status).toBe('seated');
    expect(rows[0].partySize).toBe(4);
    // Money is integer cents.
    expect(rows[0].minSpendCents).toBe(30000);
    expect(Number.isInteger(rows[0].minSpendCents)).toBe(true);
    // Entry with no minimum spend omits the field.
    expect(rows[1].minSpendCents).toBeUndefined();
    const rows2 = await a.fetchGuestList('fv_evt_201');
    expect(rows2).toEqual(rows);
  });

  it('throws in live mode for fetchGuestList (api key configured)', async () => {
    const a = make({ 'connectors.fourvenuesApiKey': 'live-key' });
    await expect(a.fetchGuestList('fv_evt_201')).rejects.toThrow(
      'Fourvenues live mode not configured in this build',
    );
  });

  it('normalises a Fourvenues-shaped event into DemandSignal', () => {
    const a = make({});
    const sig = a.normalizeEvent({
      id: 'fv_evt_999',
      name: { text: 'Warehouse Rave' },
      start_date: '2026-09-01T22:00:00.000Z',
      capacity: 750,
      venue: { name: 'The Basement' },
    });
    expect(sig.externalEventId).toBe('fv_evt_999');
    expect(sig.name).toBe('Warehouse Rave');
    expect(sig.subjectType).toBe('event');
    expect(sig.subjectRef).toBe('Warehouse Rave');
    expect(sig.startsAt).toBe('2026-09-01T22:00:00.000Z');
    expect(sig.demandWeight).toBe(750);
    expect(sig.venueHint).toBe('The Basement');
  });

  it('defaults demandWeight to 0 for an event without capacity/sold', () => {
    const a = make({});
    const sig = a.normalizeEvent({ title: 'Mystery Night' });
    expect(sig.name).toBe('Mystery Night');
    expect(sig.demandWeight).toBe(0);
    expect(sig.startsAt).toBeUndefined();
    expect(sig.venueHint).toBeUndefined();
  });

  it('maps a scanned ticket to seated and a missing/unscanned one to no_show', () => {
    const a = make({});
    expect(
      a.normalizeAttendance({
        reservation_id: 'fv_gl_1',
        scan_status: 'scanned',
      }),
    ).toEqual({ externalReservationId: 'fv_gl_1', status: 'seated' });
    expect(
      a.normalizeAttendance({ ticket_id: 'fv_gl_2', checked_in: true }),
    ).toEqual({ externalReservationId: 'fv_gl_2', status: 'seated' });
    // Missing scan info → no_show.
    expect(a.normalizeAttendance({ id: 'fv_gl_3' })).toEqual({
      externalReservationId: 'fv_gl_3',
      status: 'no_show',
    });
    expect(
      a.normalizeAttendance({ reservationId: 'fv_gl_4', status: 'voided' }),
    ).toEqual({ externalReservationId: 'fv_gl_4', status: 'no_show' });
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
      'connectors.fourvenuesWebhookSecret': secret,
    });
    const body = '{"reservation_id":"fv_gl_1","scan_status":"scanned"}';
    const sig = createHmac('sha256', secret).update(body, 'utf8').digest('hex');
    expect(a.verifyWebhook(body, sig)).toBe(true);
    expect(a.verifyWebhook(body + ' ', sig)).toBe(false);
  });
});
