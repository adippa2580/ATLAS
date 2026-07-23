import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { DemandSignal } from './connector.types';

/**
 * POSH demand-signal adapter — independent nightlife inventory & social demand.
 *
 * POSH is a social-first ticketing platform where independent hosts and
 * collectives publish events, and the A-List (POSH's social discovery feed)
 * drives users into the ticket journey. ATLAS treats each POSH event + its
 * ticket demand as a {@link DemandSignal} feeding the discovery layer, mapping
 * onward to an Entity (event/artist) in the taste graph. RSVP/capacity becomes
 * a demandWeight so Atlas can spot where independent nightlife interest is
 * clustering — separate from the ticketed-mainstream signal Eventbrite carries.
 *
 * Engagement/conversion results flow back to Atlas via webhook where the
 * partnership permits, closing the loop on which surfaced demand actually
 * converted through the POSH ticket journey.
 *
 * STUB mode when connectors.poshApiKey is unset — returns a deterministic
 * sample set so onboarding + demand insights work without live credentials,
 * mirroring the Eventbrite demand connector's stub pattern.
 *
 * Built for KAN-8.
 */
export const POSH_SIGNATURE_HEADER = 'x-posh-signature';

@Injectable()
export class PoshAdapter {
  private readonly logger = new Logger(PoshAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.poshApiKey');
  }

  /**
   * Fetch upcoming independent/social nightlife events as demand signals.
   * Stubbed deterministically (demandWeight derived from RSVP/capacity);
   * live mode is intentionally unimplemented in this build.
   */
  async fetchEvents(city?: string): Promise<DemandSignal[]> {
    if (this.stub) {
      const signals: DemandSignal[] = [
        {
          externalEventId: 'posh_evt_201',
          name: 'Basement Collective — Warehouse Rave',
          subjectType: 'event',
          subjectRef: 'Basement Collective — Warehouse Rave',
          startsAt: '2026-08-15T23:00:00.000Z',
          demandWeight: 420,
          venueHint: 'Sydney',
        },
        {
          externalEventId: 'posh_evt_202',
          name: 'DJ Sabé — Underground Set',
          subjectType: 'artist',
          subjectRef: 'DJ Sabé',
          startsAt: '2026-08-22T22:30:00.000Z',
          demandWeight: 650,
          venueHint: 'Melbourne',
        },
        {
          externalEventId: 'posh_evt_203',
          name: 'Loft Sessions — Afro House Social',
          subjectType: 'event',
          subjectRef: 'Loft Sessions — Afro House Social',
          startsAt: '2026-08-29T21:00:00.000Z',
          demandWeight: 280,
          venueHint: 'Brisbane',
        },
        {
          externalEventId: 'posh_evt_204',
          name: 'Rooftop After Dark',
          subjectType: 'event',
          subjectRef: 'Rooftop After Dark',
          startsAt: '2026-09-06T20:00:00.000Z',
          demandWeight: 510,
          venueHint: 'Sydney',
        },
      ];
      if (city) {
        const wanted = city.toLowerCase();
        return signals.filter((s) => s.venueHint?.toLowerCase() === wanted);
      }
      return signals;
    }
    throw new Error('POSH live mode not configured in this build');
  }

  /**
   * Normalise a raw POSH event object into the shared DemandSignal. Defensive
   * on field-name variants (id vs event_id, name vs title, starts_at vs start,
   * rsvp_count vs capacity). demandWeight is derived from RSVP/capacity
   * (Number, default 0).
   */
  normalizeEvent(body: any): DemandSignal {
    const name: string = body?.name ?? body?.title ?? 'Untitled event';
    const startsAt: string | undefined =
      body?.starts_at ?? body?.startsAt ?? body?.start;
    const demand = Number(body?.rsvp_count ?? body?.capacity ?? 0);
    const venueHint: string | undefined =
      body?.venue ?? body?.city ?? body?.venueHint;

    return {
      externalEventId: String(body?.id ?? body?.event_id ?? 'posh_evt_stub'),
      name,
      subjectType: body?.subjectType ?? 'event',
      subjectRef: name,
      startsAt,
      demandWeight: Number.isFinite(demand) ? demand : 0,
      venueHint: typeof venueHint === 'string' ? venueHint : undefined,
    };
  }

  /**
   * Verify an inbound POSH webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded) carrying engagement/conversion results. Fails CLOSED:
   * mismatch, missing signature, or missing secret in production all return
   * false; the permissive path only exists in dev/stub with no secret set.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.poshWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'POSH webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'POSH webhook secret unset in production — rejecting webhook',
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
