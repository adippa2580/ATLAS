import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReservationPayload } from './connector.types';

/**
 * SevenRooms adapter — reservation ingest from the SevenRooms booking system.
 * Normalises inbound reservation webhooks into the shared ReservationPayload
 * consumed by the Booking primitive.
 *
 * STUB mode when SEVENROOMS_API_KEY is unset: fetchReservations returns a
 * deterministic sample set so onboarding + booking flows work without live
 * credentials.
 *
 * Signature scheme (mirrors LightspeedAdapter): each event carries an
 * `X-SevenRooms-Signature` header containing HMAC-SHA256(rawBody, secret),
 * hex-encoded. Fail-closed in production.
 */
export const SEVENROOMS_SIGNATURE_HEADER = 'x-sevenrooms-signature';

@Injectable()
export class SevenroomsAdapter {
  private readonly logger = new Logger(SevenroomsAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.sevenroomsApiKey');
  }

  /**
   * Verify an inbound SevenRooms webhook signature (HMAC-SHA256 of the raw
   * body, hex-encoded). Fails CLOSED: mismatch, missing signature, or missing
   * secret in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>(
      'connectors.sevenroomsWebhookSecret',
    );
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'SevenRooms webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'SevenRooms webhook secret unset in production — rejecting webhook',
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
   * Normalise a raw SevenRooms reservation webhook body into the shared
   * ReservationPayload (integer cents). Defensive about field-name variants
   * since SevenRooms payloads differ across event types and API versions.
   */
  normalizeReservation(body: any): ReservationPayload {
    const partySize = Number(
      body?.party_size ?? body?.partySize ?? body?.guests ?? body?.covers ?? 0,
    );

    const date =
      body?.arrival_time ??
      body?.arrivalTime ??
      body?.reservation_time ??
      body?.reservationTime ??
      body?.date ??
      body?.time ??
      '';

    const rawMinSpend =
      body?.minimum_spend ??
      body?.min_spend ??
      body?.minSpend ??
      body?.minimumSpend;

    return {
      externalReservationId:
        body?.reservation_id ??
        body?.reservationId ??
        body?.id ??
        'sr_res_stub',
      guestName:
        body?.guest_name ??
        body?.guestName ??
        this.joinName(body?.first_name, body?.last_name) ??
        body?.name,
      guestPhone: body?.guest_phone ?? body?.guestPhone ?? body?.phone,
      guestEmail: body?.guest_email ?? body?.guestEmail ?? body?.email,
      partySize,
      date: String(date),
      tableRef:
        body?.table ??
        body?.table_number ??
        body?.tableRef ??
        body?.seating_area ??
        body?.seatingArea,
      status: this.normalizeStatus(body?.status),
      ...(rawMinSpend != null
        ? { minSpendCents: Math.round(Number(rawMinSpend)) }
        : {}),
    };
  }

  private joinName(first?: string, last?: string): string | undefined {
    const parts = [first, last].filter(Boolean);
    return parts.length ? parts.join(' ') : undefined;
  }

  private normalizeStatus(raw: any): ReservationPayload['status'] {
    switch (String(raw ?? '').toUpperCase()) {
      case 'SEATED':
        return 'seated';
      case 'CANCELLED':
      case 'CANCELED':
        return 'cancelled';
      case 'NO_SHOW':
      case 'NOSHOW':
        return 'no_show';
      case 'BOOKED':
      case 'CONFIRMED':
      default:
        return 'booked';
    }
  }

  /**
   * Fetch reservations for a venue. Stubbed deterministically; live mode is
   * not wired in this build.
   */
  async fetchReservations(
    _venueExternalId: string,
  ): Promise<ReservationPayload[]> {
    if (this.stub) {
      return [
        {
          externalReservationId: 'sr_res_1001',
          guestName: 'Amara Okafor',
          guestPhone: '+61400111222',
          guestEmail: 'amara@example.com',
          partySize: 4,
          date: '2026-07-22T19:00:00.000Z',
          tableRef: 'B2',
          status: 'booked',
          minSpendCents: 40000,
        },
        {
          externalReservationId: 'sr_res_1002',
          guestName: 'Tomás Rivera',
          guestPhone: '+61400333444',
          guestEmail: 'tomas@example.com',
          partySize: 2,
          date: '2026-07-22T20:30:00.000Z',
          tableRef: 'Bar-3',
          status: 'seated',
        },
        {
          externalReservationId: 'sr_res_1003',
          guestName: 'Priya Nair',
          partySize: 6,
          date: '2026-07-22T21:00:00.000Z',
          tableRef: 'Booth-1',
          status: 'booked',
          minSpendCents: 75000,
        },
      ];
    }
    throw new Error('SevenRooms live mode not configured in this build');
  }
}
