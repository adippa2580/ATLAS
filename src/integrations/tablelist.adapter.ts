import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ReservationPayload } from './connector.types';

/**
 * TablelistPro adapter — reservation ingest from the TablelistPro booking /
 * table-management system (a SevenRooms alternative). Normalises inbound
 * reservation webhooks into the shared ReservationPayload consumed by the
 * Booking primitive.
 *
 * ATLAS mapping: table bookings originate from A-List and are routed here;
 * reservations sync down to the venue's table map, and attendance,
 * booking-changes, visit-history and spend flow back up to Atlas →
 * Booking / Tab / Guest primitives. TablelistPro also surfaces guest-CRM
 * fields (name, phone, email) which enrich the Guest record on ingest.
 *
 * STUB mode when TABLELIST_API_KEY is unset: fetchReservations returns a
 * deterministic sample set so onboarding + booking flows work without live
 * credentials.
 *
 * Signature scheme (mirrors SevenroomsAdapter): each event carries an
 * `X-Tablelist-Signature` header containing HMAC-SHA256(rawBody, secret),
 * hex-encoded. Fail-closed in production.
 *
 * Built for KAN-12 (TablelistPro; SevenRooms covered by SevenroomsAdapter).
 */
export const TABLELIST_SIGNATURE_HEADER = 'x-tablelist-signature';

@Injectable()
export class TablelistAdapter {
  private readonly logger = new Logger(TablelistAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.tablelistApiKey');
  }

  /**
   * Verify an inbound TablelistPro webhook signature (HMAC-SHA256 of the raw
   * body, hex-encoded). Fails CLOSED: mismatch, missing signature, or missing
   * secret in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.tablelistWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'Tablelist webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Tablelist webhook secret unset in production — rejecting webhook',
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
   * Normalise a raw TablelistPro reservation webhook body into the shared
   * ReservationPayload (integer cents). Defensive about field-name variants
   * since TablelistPro payloads differ across event types and API versions.
   *
   * Money: a `min_spend_cents` field is already integer cents and used as-is;
   * a `min_spend` field is vendor dollars and converted (× 100, rounded).
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

    const minSpendCents = this.resolveMinSpendCents(body);

    return {
      externalReservationId:
        body?.reservation_id ??
        body?.reservationId ??
        body?.booking_id ??
        body?.bookingId ??
        body?.id ??
        'tl_res_stub',
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
      ...(minSpendCents != null ? { minSpendCents } : {}),
    };
  }

  /**
   * Resolve per-reservation minimum spend to integer cents. Prefers an
   * explicit `*_cents` field (already minor units); otherwise treats the
   * dollar-denominated field as major units and converts.
   */
  private resolveMinSpendCents(body: any): number | undefined {
    const rawCents = body?.min_spend_cents ?? body?.minSpendCents;
    if (rawCents != null) {
      return Math.round(Number(rawCents));
    }

    const rawDollars =
      body?.min_spend ??
      body?.minSpend ??
      body?.minimum_spend ??
      body?.minimumSpend;
    if (rawDollars != null) {
      return Math.round(Number(rawDollars) * 100);
    }

    return undefined;
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
          externalReservationId: 'tl_res_2001',
          guestName: 'Dana Whitfield',
          guestPhone: '+61400555666',
          guestEmail: 'dana@example.com',
          partySize: 4,
          date: '2026-07-24T19:30:00.000Z',
          tableRef: 'T12',
          status: 'booked',
          minSpendCents: 50000,
        },
        {
          externalReservationId: 'tl_res_2002',
          guestName: 'Marcus Lindqvist',
          guestPhone: '+61400777888',
          guestEmail: 'marcus@example.com',
          partySize: 2,
          date: '2026-07-24T20:00:00.000Z',
          tableRef: 'Lounge-4',
          status: 'seated',
        },
        {
          externalReservationId: 'tl_res_2003',
          guestName: 'Line Sørensen',
          partySize: 8,
          date: '2026-07-24T21:15:00.000Z',
          tableRef: 'VIP-2',
          status: 'booked',
          minSpendCents: 120000,
        },
      ];
    }
    throw new Error('Tablelist live mode not configured in this build');
  }
}
