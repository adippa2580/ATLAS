import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ReservationPayload } from './connector.types';

/**
 * Resy reservations adapter — booking sync. Normalises Resy reservation
 * shapes into the shared ReservationPayload consumed by the Booking primitive,
 * regardless of vendor (mirrors the SevenRooms/Tock path).
 *
 * STUB mode when RESY_API_KEY is unset: fetchReservations returns a
 * deterministic sample set so onboarding + discovery work without live creds.
 *
 * Signature scheme: each webhook carries an `X-Resy-Signature` header
 * containing HMAC-SHA256(rawBody, webhookSecret), hex-encoded. Fail-closed in
 * production — same scheme as LightspeedAdapter.
 */
export const RESY_SIGNATURE_HEADER = 'x-resy-signature';

@Injectable()
export class ResyAdapter {
  private readonly logger = new Logger(ResyAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.resyApiKey');
  }

  /**
   * Verify an inbound Resy webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded). Fails CLOSED: mismatch, missing signature, or missing secret
   * in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.resyWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'Resy webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Resy webhook secret unset in production — rejecting webhook',
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
   * Normalise a raw Resy reservation body into the shared ReservationPayload
   * (integer-cent money). Defensive on field names since Resy webhook and API
   * shapes differ (num_seats vs party_size, day/time vs date, etc.).
   */
  normalizeReservation(body: any): ReservationPayload {
    const rawStatus = String(
      body?.status ?? body?.reservation_status ?? 'booked',
    ).toLowerCase();
    const status = this.mapStatus(rawStatus);

    const partySize = Number(
      body?.num_seats ?? body?.party_size ?? body?.party ?? body?.covers ?? 0,
    );

    const date = this.resolveDate(body);

    const minSpendRaw =
      body?.min_spend_cents ??
      body?.minSpendCents ??
      body?.min_spend ??
      body?.minimum_spend;

    const payload: ReservationPayload = {
      externalReservationId: String(
        body?.externalReservationId ??
          body?.reservation_id ??
          body?.resy_token ??
          body?.id ??
          'resy_res_stub',
      ),
      guestName:
        body?.guestName ??
        body?.guest_name ??
        this.joinName(body?.first_name, body?.last_name) ??
        body?.guest?.name,
      guestPhone:
        body?.guestPhone ??
        body?.guest_phone ??
        body?.phone ??
        body?.guest?.phone,
      guestEmail:
        body?.guestEmail ??
        body?.guest_email ??
        body?.email ??
        body?.guest?.email,
      partySize,
      date,
      tableRef:
        body?.tableRef ??
        body?.table ??
        body?.table_name ??
        body?.table_id ??
        undefined,
      status,
    };

    if (minSpendRaw != null && minSpendRaw !== '') {
      payload.minSpendCents = Math.round(Number(minSpendRaw));
    }

    return payload;
  }

  /** Fetch reservations for a venue. Stubbed deterministically. */
  async fetchReservations(
    _venueExternalId: string,
  ): Promise<ReservationPayload[]> {
    if (this.stub) {
      return [
        {
          externalReservationId: 'resy_res_1001',
          guestName: 'Amara Chen',
          guestPhone: '+14155550101',
          guestEmail: 'amara@example.com',
          partySize: 4,
          date: '2026-07-24T20:00:00.000Z',
          tableRef: 'A12',
          status: 'booked',
          minSpendCents: 50000,
        },
        {
          externalReservationId: 'resy_res_1002',
          guestName: 'Diego Marlowe',
          guestPhone: '+14155550102',
          guestEmail: 'diego@example.com',
          partySize: 2,
          date: '2026-07-24T21:30:00.000Z',
          tableRef: 'B03',
          status: 'seated',
        },
        {
          externalReservationId: 'resy_res_1003',
          guestName: 'Priya Nair',
          guestPhone: '+14155550103',
          guestEmail: 'priya@example.com',
          partySize: 6,
          date: '2026-07-25T19:00:00.000Z',
          tableRef: 'VIP1',
          status: 'booked',
          minSpendCents: 120000,
        },
      ];
    }
    throw new Error('Resy live mode not configured in this build');
  }

  private mapStatus(raw: string): ReservationPayload['status'] {
    switch (raw) {
      case 'seated':
      case 'checked_in':
      case 'arrived':
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

  private resolveDate(body: any): string {
    if (body?.date) return String(body.date);
    if (body?.datetime) return String(body.datetime);
    const day = body?.day ?? body?.date_day;
    const time = body?.time ?? body?.date_time;
    if (day && time) return `${day}T${time}`;
    if (day) return String(day);
    return '';
  }

  private joinName(first?: string, last?: string): string | undefined {
    const parts = [first, last].filter(Boolean);
    return parts.length ? parts.join(' ') : undefined;
  }
}
