import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DemandSignal, ReservationPayload } from './connector.types';

/**
 * Fourvenues adapter — nightlife ticketing, guest lists and venue operations.
 * Built for KAN-6.
 *
 * ATLAS mapping:
 * - Events (ticketed nightlife dates) → {@link DemandSignal} feeding the
 *   discovery layer; each event becomes/enriches an Entity(kind=event) whose
 *   demandWeight (capacity vs sold) shows where audience interest is clustering.
 * - Guest list entries → {@link ReservationPayload} consumed by the Booking
 *   primitive, each row a Booking attached to a Guest (name/phone/email), with
 *   an optional per-entry minimum spend in integer cents.
 * - Ticket scans / door check-ins → attendance evidence fed back into Atlas
 *   (seated vs no_show) so a Booking's realised attendance updates the taste
 *   graph and the guest's affinity signal.
 *
 * STUB mode when CONNECTORS_FOURVENUES_API_KEY is unset: fetchEvents and
 * fetchGuestList return deterministic sample sets so onboarding + demand and
 * booking flows work without live credentials, mirroring the Eventbrite and
 * SevenRooms connector stubs.
 *
 * Signature scheme (mirrors LightspeedAdapter / SevenroomsAdapter): each
 * webhook carries an `X-Fourvenues-Signature` header containing
 * HMAC-SHA256(rawBody, secret), hex-encoded. Fail-closed in production.
 */
export const FOURVENUES_SIGNATURE_HEADER = 'x-fourvenues-signature';

@Injectable()
export class FourvenuesAdapter {
  private readonly logger = new Logger(FourvenuesAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.fourvenuesApiKey');
  }

  /**
   * Fetch upcoming events for a venue as demand signals. Stubbed
   * deterministically; live mode is intentionally unimplemented in this build.
   */
  async fetchEvents(_venueId: string): Promise<DemandSignal[]> {
    if (this.stub) {
      return [
        {
          externalEventId: 'fv_evt_201',
          name: 'Techno Basement — Opening Night',
          subjectType: 'event',
          subjectRef: 'Techno Basement — Opening Night',
          startsAt: '2026-08-15T23:00:00.000Z',
          demandWeight: 600,
          venueHint: 'Barcelona',
        },
        {
          externalEventId: 'fv_evt_202',
          name: 'Rooftop Sundowners',
          subjectType: 'event',
          subjectRef: 'Rooftop Sundowners',
          startsAt: '2026-08-22T18:00:00.000Z',
          demandWeight: 320,
          venueHint: 'Madrid',
        },
        {
          externalEventId: 'fv_evt_203',
          name: 'Indira Paganotto Presents',
          subjectType: 'artist',
          subjectRef: 'Indira Paganotto',
          startsAt: '2026-08-29T23:30:00.000Z',
          demandWeight: 950,
          venueHint: 'Ibiza',
        },
      ];
    }
    throw new Error('Fourvenues live mode not configured in this build');
  }

  /**
   * Fetch the guest list for an event, normalised to ReservationPayload
   * (integer cents). Stubbed deterministically; live mode is not wired in this
   * build.
   */
  async fetchGuestList(_eventId: string): Promise<ReservationPayload[]> {
    if (this.stub) {
      return [
        {
          externalReservationId: 'fv_gl_3001',
          guestName: 'Lucía Fernández',
          guestPhone: '+34600111222',
          guestEmail: 'lucia@example.com',
          partySize: 4,
          date: '2026-08-15T23:30:00.000Z',
          tableRef: 'VIP-2',
          status: 'booked',
          minSpendCents: 30000,
        },
        {
          externalReservationId: 'fv_gl_3002',
          guestName: 'Marco Rossi',
          guestPhone: '+34600333444',
          partySize: 2,
          date: '2026-08-15T23:45:00.000Z',
          status: 'seated',
        },
        {
          externalReservationId: 'fv_gl_3003',
          guestName: 'Aisha Khan',
          guestEmail: 'aisha@example.com',
          partySize: 6,
          date: '2026-08-16T00:15:00.000Z',
          tableRef: 'Booth-4',
          status: 'booked',
          minSpendCents: 50000,
        },
      ];
    }
    throw new Error('Fourvenues live mode not configured in this build');
  }

  /**
   * Normalise a raw Fourvenues event object into the shared DemandSignal.
   * Defensive on field-name variants across API versions. demandWeight is
   * derived from capacity/sold (Number, default 0).
   */
  normalizeEvent(body: any): DemandSignal {
    const name: string =
      body?.name?.text ?? body?.name ?? body?.title ?? 'Untitled event';
    const startsAt: string | undefined =
      body?.starts_at ??
      body?.startsAt ??
      body?.start_date ??
      body?.startDate ??
      body?.date;
    const capacity = Number(
      body?.capacity ??
        body?.sold ??
        body?.tickets_sold ??
        body?.ticketsSold ??
        0,
    );
    const venueHint: unknown =
      body?.venue?.name ??
      body?.venue?.city ??
      body?.city ??
      body?.venueHint ??
      body?.venue;

    return {
      externalEventId: String(body?.id ?? body?.event_id ?? 'fv_evt_stub'),
      name,
      subjectType: 'event',
      subjectRef: name,
      startsAt: typeof startsAt === 'string' ? startsAt : undefined,
      demandWeight: Number.isFinite(capacity) ? capacity : 0,
      venueHint: typeof venueHint === 'string' ? venueHint : undefined,
    };
  }

  /**
   * Normalise a ticket-scan / door check-in webhook into an attendance update.
   * A scanned/checked-in ticket maps to 'seated'; anything else (voided,
   * refunded, never scanned) maps to 'no_show'. Fed back into Atlas as
   * attendance evidence on the matching Booking.
   */
  normalizeAttendance(body: any): {
    externalReservationId: string;
    status: 'seated' | 'no_show';
  } {
    const externalReservationId = String(
      body?.reservation_id ??
        body?.reservationId ??
        body?.ticket_id ??
        body?.ticketId ??
        body?.id ??
        'fv_gl_stub',
    );
    const raw = String(
      body?.scan_status ?? body?.scanStatus ?? body?.status ?? '',
    ).toLowerCase();
    const scanned =
      raw === 'scanned' ||
      raw === 'checked_in' ||
      raw === 'checkedin' ||
      raw === 'check_in' ||
      body?.scanned === true ||
      body?.checked_in === true ||
      body?.checkedIn === true;

    return {
      externalReservationId,
      status: scanned ? 'seated' : 'no_show',
    };
  }

  /**
   * Verify an inbound Fourvenues webhook signature (HMAC-SHA256 of the raw
   * body, hex-encoded). Fails CLOSED: mismatch, missing signature, or missing
   * secret in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>(
      'connectors.fourvenuesWebhookSecret',
    );
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'Fourvenues webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Fourvenues webhook secret unset in production — rejecting webhook',
      );
      return false;
    }

    if (!signature || rawBody == null) return false;

    const body =
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret)
      .update(body, 'utf8')
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const signatureBuf = Buffer.from(signature, 'utf8');

    return (
      signatureBuf.length === expectedBuf.length &&
      timingSafeEqual(signatureBuf, expectedBuf)
    );
  }
}
