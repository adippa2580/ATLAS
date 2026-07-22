import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ReservationPayload } from './connector.types';

/**
 * Tock adapter — prepaid-reservation / experience booking sync. Tock is a
 * deposit- and ticket-forward reservations platform (fixed-price experiences,
 * event tickets, and standard tables), so a booking often carries a prepaid
 * amount which we surface as an optional per-reservation minimum spend.
 *
 * Normalises to the vendor-agnostic ReservationPayload consumed by the Booking
 * primitive, mirroring the SevenRooms/Resy reservation connectors.
 *
 * STUB mode when TOCK_API_KEY is unset.
 *
 * Signature scheme (same fail-closed HMAC-SHA256 hex scheme as the Lightspeed
 * webhook path): each event carries an `X-Tock-Signature` header containing
 * HMAC-SHA256(rawBody, webhookSecret), hex-encoded. Fail-closed in production.
 */
export const TOCK_SIGNATURE_HEADER = 'x-tock-signature';

@Injectable()
export class TockAdapter {
  private readonly logger = new Logger(TockAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.tockApiKey');
  }

  /**
   * Verify an inbound Tock webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded). Fails CLOSED: mismatch, missing signature, or missing secret
   * in production all return false; the permissive path only exists in dev/stub
   * with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.tockWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'Tock webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Tock webhook secret unset in production — rejecting webhook',
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

  /**
   * Normalise a raw Tock booking webhook body into the shared
   * ReservationPayload (integer cents). Defensive on field names — Tock's
   * payloads vary across standard reservations, experiences, and event tickets.
   */
  normalizeReservation(body: any): ReservationPayload {
    return {
      externalReservationId: String(
        body?.externalReservationId ??
          body?.bookingId ??
          body?.reservationId ??
          body?.id ??
          'tock_res_stub',
      ),
      guestName:
        body?.guestName ??
        body?.diner?.name ??
        body?.customer?.name ??
        ([body?.firstName, body?.lastName].filter(Boolean).join(' ') ||
          undefined),
      guestPhone:
        body?.guestPhone ??
        body?.diner?.phone ??
        body?.customer?.phone ??
        body?.phone ??
        undefined,
      guestEmail:
        body?.guestEmail ??
        body?.diner?.email ??
        body?.customer?.email ??
        body?.email ??
        undefined,
      partySize: Number(body?.partySize ?? body?.guests ?? body?.covers ?? 0),
      date:
        body?.date ??
        body?.datetime ??
        body?.experienceDatetime ??
        body?.startTime ??
        body?.reservationTime ??
        '',
      tableRef:
        body?.tableRef ??
        body?.experienceRef ??
        body?.experienceId ??
        body?.table ??
        body?.experienceName ??
        undefined,
      status: this.mapStatus(body?.status ?? body?.state),
      minSpendCents: this.toCents(
        body?.minSpendCents ??
          body?.prepaidAmount ??
          body?.depositAmount ??
          body?.prepaid ??
          body?.amountPaid,
      ),
    };
  }

  private mapStatus(raw: any): ReservationPayload['status'] {
    switch (String(raw ?? '').toLowerCase()) {
      case 'seated':
      case 'arrived':
      case 'checked_in':
        return 'seated';
      case 'cancelled':
      case 'canceled':
        return 'cancelled';
      case 'no_show':
      case 'noshow':
      case 'no-show':
        return 'no_show';
      default:
        return 'booked';
    }
  }

  private toCents(raw: any): number | undefined {
    if (raw == null || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) return undefined;
    return Math.round(n);
  }

  /**
   * Fetch reservations for a venue. Stubbed deterministically so onboarding +
   * discovery work without live Tock credentials.
   */
  async fetchReservations(
    _venueExternalId: string,
  ): Promise<ReservationPayload[]> {
    if (this.stub) {
      return [
        {
          externalReservationId: 'tock_res_1001',
          guestName: 'Amara Osei',
          guestPhone: '+61400111222',
          guestEmail: 'amara@example.com',
          partySize: 2,
          date: '2026-07-25T19:00:00.000Z',
          tableRef: 'chefs-counter-tasting',
          status: 'booked',
          minSpendCents: 24000,
        },
        {
          externalReservationId: 'tock_res_1002',
          guestName: 'Liang Wei',
          guestPhone: '+61400333444',
          guestEmail: 'liang@example.com',
          partySize: 4,
          date: '2026-07-26T20:30:00.000Z',
          tableRef: 'main-dining',
          status: 'seated',
          minSpendCents: 60000,
        },
        {
          externalReservationId: 'tock_res_1003',
          guestName: 'Priya Nair',
          guestPhone: '+61400555666',
          guestEmail: 'priya@example.com',
          partySize: 6,
          date: '2026-07-27T18:00:00.000Z',
          tableRef: 'private-room',
          status: 'cancelled',
        },
      ];
    }
    throw new Error('Tock live mode not configured in this build');
  }
}
