import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ConfirmedTalentEvent, TalentShortlistItem } from './connector.types';

/**
 * GigFinesse — artist-booking execution connector. GigFinesse is a talent
 * marketplace that matches venues with performing artists and runs the booking
 * lifecycle (offer → negotiation → confirmed engagement). Atlas uses it as the
 * execution layer on top of its own taste/demand intelligence: Atlas decides
 * WHO to book, GigFinesse handles the transacting.
 *
 * ATLAS mapping:
 *  - Outbound: Atlas sends a ranked shortlist (artist + fit rank + budget cap)
 *    for a (venue, date) — `submitShortlist`. This is Atlas's modeled intent.
 *  - Inbound: a confirmed booking comes back as a ConfirmedTalentEvent, which
 *    populates a TalentEngagement primitive and upserts the artist as an
 *    Entity(kind=artist) on the venue's A-List. Money is integer cents.
 *
 * STUB mode when GIGFINESSE_API_KEY (connectors.gigfinesseApiKey) is unset —
 * returns deterministic sample data so onboarding + the A-List work without
 * live credentials, mirroring the other stub-first connectors.
 *
 * Ported for KAN-4.
 */
export const GIGFINESSE_SIGNATURE_HEADER = 'x-gigfinesse-signature';

@Injectable()
export class GigfinesseAdapter {
  private readonly logger = new Logger(GigfinesseAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.gigfinesseApiKey');
  }

  /**
   * Outbound: submit a ranked talent shortlist for a (venue, date) with budget
   * caps. Stub returns a deterministic submissionId + accepted count; live mode
   * is intentionally unimplemented in this build.
   */
  async submitShortlist(
    venueId: string,
    date: string,
    items: TalentShortlistItem[],
  ): Promise<{ submissionId: string; accepted: number }> {
    if (this.stub) {
      return {
        submissionId: `gf_sub_${venueId}_${date}`,
        accepted: items.length,
      };
    }
    throw new Error('GigFinesse live mode not configured in this build');
  }

  /**
   * Inbound: fetch confirmed engagements for a venue. Stub returns deterministic
   * ConfirmedTalentEvent rows (feeCents integer cents, status 'confirmed'); live
   * mode is intentionally unimplemented in this build.
   */
  async fetchConfirmed(venueId: string): Promise<ConfirmedTalentEvent[]> {
    if (this.stub) {
      return [
        {
          externalBookingId: `gf_bk_${venueId}_1`,
          artistRef: 'Sofia Kourtesis',
          date: '2026-09-12T21:00:00.000Z',
          feeCents: 450000,
          status: 'confirmed',
          venueHint: 'Sydney',
        },
        {
          externalBookingId: `gf_bk_${venueId}_2`,
          artistRef: 'DJ Boring',
          date: '2026-09-19T22:00:00.000Z',
          feeCents: 320000,
          status: 'confirmed',
          venueHint: 'Melbourne',
        },
        {
          externalBookingId: `gf_bk_${venueId}_3`,
          artistRef: 'Anz',
          date: '2026-09-26T22:30:00.000Z',
          feeCents: 610000,
          status: 'confirmed',
          venueHint: 'Brisbane',
        },
      ];
    }
    throw new Error('GigFinesse live mode not configured in this build');
  }

  /**
   * Normalise a raw GigFinesse booking body into the shared ConfirmedTalentEvent
   * (integer cents). Defensive on field-name variants across the vendor's
   * webhook/API shapes. Money stays integer cents: a `*_cents` field is used
   * verbatim; only when no cents field is present and a `feeDollars` value is
   * given do we convert (*100, Math.round) — never introducing floats.
   */
  normalizeConfirmed(body: any): ConfirmedTalentEvent {
    const artistRef: string = String(
      body?.artist ??
        body?.artistRef ??
        body?.artist_name ??
        body?.artistName ??
        'Unknown artist',
    );

    const date: string = String(
      body?.date ?? body?.starts_at ?? body?.startsAt ?? body?.start ?? '',
    );

    const status = this.normalizeStatus(body?.status);

    const feeCents = this.resolveFeeCents(body);

    const venueHintRaw =
      body?.venueHint ?? body?.venue_hint ?? body?.venue ?? body?.city;

    return {
      externalBookingId: String(
        body?.booking_id ?? body?.bookingId ?? body?.id ?? 'gf_bk_stub',
      ),
      artistRef,
      date,
      feeCents,
      status,
      venueHint:
        typeof venueHintRaw === 'string' && venueHintRaw.length > 0
          ? venueHintRaw
          : undefined,
    };
  }

  /**
   * Resolve an integer-cent fee from the vendor's variant fields. Prefers an
   * explicit `*_cents` field; falls back to `feeDollars` only when no cents
   * field exists (converting dollars → cents without floats).
   */
  private resolveFeeCents(body: any): number {
    const centsField =
      body?.fee_cents ?? body?.feeCents ?? body?.amount_cents ?? body?.fee;
    if (centsField != null) {
      return Math.round(Number(centsField)) || 0;
    }
    const dollars = body?.feeDollars ?? body?.fee_dollars;
    if (dollars != null) {
      return Math.round(Number(dollars) * 100) || 0;
    }
    return 0;
  }

  private normalizeStatus(raw: unknown): ConfirmedTalentEvent['status'] {
    const value = String(raw ?? '').toLowerCase();
    if (value === 'offered' || value === 'cancelled') {
      return value;
    }
    return 'confirmed';
  }

  /**
   * Verify an inbound GigFinesse webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded). Fails CLOSED: mismatch, missing signature, or missing secret
   * in production all return false; the permissive path only exists in dev/stub
   * with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>(
      'connectors.gigfinesseWebhookSecret',
    );
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'GigFinesse webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'GigFinesse webhook secret unset in production — rejecting webhook',
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
