import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DemandSignal } from './connector.types';

/**
 * DICE ticketing & attendance adapter — the primary ticketing connector.
 *
 * ATLAS mapping:
 * - DICE events → {@link DemandSignal} / Entity: each on-sale becomes a
 *   demand signal (allocation/sold → demandWeight) the discovery layer uses
 *   to recommend artists and events to users and crews via the A-List.
 * - Purchases → guest graph: ticket holders enrich the taste/guest graph so
 *   Atlas knows who is coming and what they book.
 * - Scan data → attendance evidence: door scans feed the evidence pipeline to
 *   *verify* attendance (someone actually showed up), not merely intent.
 *
 * STUB mode when DICE_API_KEY is unset — returns a deterministic sample set so
 * onboarding + demand insights work without live credentials, mirroring the
 * Eventbrite demand connector's stub pattern.
 *
 * Built for KAN-9.
 */
@Injectable()
export class DiceAdapter {
  private readonly logger = new Logger(DiceAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.diceApiKey');
  }

  /**
   * Fetch upcoming DICE events for a venue as demand signals. Stubbed
   * deterministically (demandWeight derived from allocation/sold); live mode is
   * intentionally unimplemented in this build.
   */
  async fetchEvents(_venueId: string): Promise<DemandSignal[]> {
    if (this.stub) {
      return [
        {
          externalEventId: 'dice_evt_501',
          name: 'Overmono — Live',
          subjectType: 'artist',
          subjectRef: 'Overmono',
          startsAt: '2026-08-15T21:00:00.000Z',
          demandWeight: 900,
          venueHint: 'Sydney',
        },
        {
          externalEventId: 'dice_evt_502',
          name: 'Warehouse Basement Takeover',
          subjectType: 'event',
          subjectRef: 'Warehouse Basement Takeover',
          startsAt: '2026-08-22T22:30:00.000Z',
          demandWeight: 450,
          venueHint: 'Melbourne',
        },
        {
          externalEventId: 'dice_evt_503',
          name: 'Fred again.. All Night',
          subjectType: 'artist',
          subjectRef: 'Fred again..',
          startsAt: '2026-09-03T21:30:00.000Z',
          demandWeight: 1600,
          venueHint: 'Brisbane',
        },
      ];
    }
    throw new Error('DICE live mode not configured in this build');
  }

  /**
   * Normalise a raw DICE event object into the shared {@link DemandSignal}.
   * Defensive on field-name variants (id/event_id, name, artists[] →
   * subjectRef/subjectType 'artist' when present else 'event', date/start_time,
   * sold_count/allocation → demandWeight).
   */
  normalizeEvent(body: any): DemandSignal {
    const name: string = body?.name ?? body?.title ?? 'Untitled event';

    const artists: unknown = body?.artists;
    const firstArtist: string | undefined =
      Array.isArray(artists) && artists.length > 0
        ? typeof artists[0] === 'string'
          ? artists[0]
          : (artists[0]?.name as string | undefined)
        : undefined;

    const subjectType: DemandSignal['subjectType'] = firstArtist
      ? 'artist'
      : 'event';
    const subjectRef: string = firstArtist ?? name;

    const startsAt: string | undefined =
      body?.date ?? body?.start_time ?? body?.startsAt ?? body?.start;

    const demand = Number(
      body?.sold_count ?? body?.allocation ?? body?.demandWeight ?? 0,
    );

    const venueHint: string | undefined =
      body?.venue?.name ?? body?.venueHint ?? body?.venue ?? body?.city;

    return {
      externalEventId: String(body?.id ?? body?.event_id ?? 'dice_evt_stub'),
      name,
      subjectType,
      subjectRef,
      startsAt: typeof startsAt === 'string' ? startsAt : undefined,
      demandWeight: Number.isFinite(demand) ? demand : 0,
      venueHint: typeof venueHint === 'string' ? venueHint : undefined,
    };
  }

  /**
   * Normalise a raw DICE attendance/scan webhook body into the minimal shape
   * the attendance-evidence pipeline needs. Defensive on field-name variants
   * (ticket_id/id, holder email/phone, scanned_at).
   */
  normalizeScan(body: any): {
    externalTicketId: string;
    guestEmail?: string;
    guestPhone?: string;
    scannedAt?: string;
  } {
    const email: unknown =
      body?.holder?.email ?? body?.guestEmail ?? body?.email;
    const phone: unknown =
      body?.holder?.phone ?? body?.guestPhone ?? body?.phone;
    const scannedAt: unknown =
      body?.scanned_at ?? body?.scannedAt ?? body?.timestamp;

    return {
      externalTicketId: String(
        body?.ticket_id ?? body?.ticketId ?? body?.id ?? 'dice_ticket_stub',
      ),
      guestEmail: typeof email === 'string' ? email : undefined,
      guestPhone: typeof phone === 'string' ? phone : undefined,
      scannedAt: typeof scannedAt === 'string' ? scannedAt : undefined,
    };
  }

  /**
   * Verify an inbound DICE webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded). Fails CLOSED: mismatch, missing signature, or missing secret
   * in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.diceWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'DICE webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'DICE webhook secret unset in production — rejecting webhook',
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
