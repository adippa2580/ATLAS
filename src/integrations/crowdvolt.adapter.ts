import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { ResaleSignal } from './connector.types';

/**
 * CrowdVolt secondary-market adapter — sold-out ticket inventory & resale
 * demand. Ingests resale-market activity on sold-out shows as a
 * demand-intelligence signal (never inventory Atlas sells).
 *
 * ATLAS mapping: CrowdVolt covers the resale routes for sold-out A-List
 * events. Resale activity, late demand and price pressure (resale price ÷ face
 * value) become a demand signal that surfaces undersupplied artists/events —
 * where audience interest outruns primary supply — so the discovery layer can
 * spot who to book/promote next. Money reasoning stays in integer cents;
 * `pricePressure` itself is a unitless ratio, not money.
 *
 * STUB mode when CROWDVOLT_API_KEY (connectors.crowdvoltApiKey) is unset —
 * returns a deterministic sample set so demand insights work without live
 * credentials, mirroring the Eventbrite demand connector's stub pattern.
 *
 * Built for KAN-11.
 */
@Injectable()
export class CrowdvoltAdapter {
  private readonly logger = new Logger(CrowdvoltAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.crowdvoltApiKey');
  }

  /**
   * Fetch resale-demand signals for the given events (or a default sample set
   * when no refs are supplied). Stubbed deterministically; live mode is
   * intentionally unimplemented in this build.
   */
  async fetchResaleDemand(_eventRefs?: string[]): Promise<ResaleSignal[]> {
    if (this.stub) {
      return [
        {
          externalEventId: 'cv_evt_501',
          eventName: 'Fred again.. — Warehouse Project',
          subjectRef: 'Fred again..',
          resaleVolume: 420,
          pricePressure: 1.4,
          soldOut: true,
          startsAt: '2026-09-12T21:00:00.000Z',
          venueHint: 'Sydney',
        },
        {
          externalEventId: 'cv_evt_502',
          eventName: 'Bicep Live',
          subjectRef: 'Bicep',
          resaleVolume: 260,
          pricePressure: 1.85,
          soldOut: true,
          startsAt: '2026-09-19T22:00:00.000Z',
          venueHint: 'Melbourne',
        },
        {
          externalEventId: 'cv_evt_503',
          eventName: 'Overmono — All Night Long',
          subjectRef: 'Overmono',
          resaleVolume: 150,
          pricePressure: 1.25,
          soldOut: true,
          startsAt: '2026-09-26T21:30:00.000Z',
          venueHint: 'Brisbane',
        },
      ];
    }
    throw new Error('CrowdVolt live mode not configured in this build');
  }

  /**
   * Normalise a raw CrowdVolt listing/event object into the shared
   * ResaleSignal. Defensive on field-name variants. `resaleVolume` derives from
   * the active-listing count (Number, default 0). `pricePressure` is the resale
   * price ÷ face value when both are present and face > 0, else 1 (a plain
   * unitless ratio — divide-by-zero guarded).
   */
  normalizeListing(body: any): ResaleSignal {
    const eventName: string =
      body?.event ?? body?.name ?? body?.event_name ?? 'Untitled event';
    const startsAt: string | undefined =
      body?.starts_at ?? body?.startsAt ?? body?.start;
    const resaleVolume = Number(
      body?.listings ?? body?.active_listings ?? body?.resaleVolume ?? 0,
    );
    const resalePrice = Number(body?.resale_price ?? body?.resalePrice);
    const faceValue = Number(body?.face_value ?? body?.faceValue);
    const pricePressure =
      Number.isFinite(resalePrice) &&
      Number.isFinite(faceValue) &&
      faceValue > 0
        ? resalePrice / faceValue
        : 1;
    const venueHint: string | undefined = body?.venue ?? body?.venueHint;

    return {
      externalEventId: String(body?.id ?? body?.event_id ?? 'cv_evt_stub'),
      eventName,
      subjectRef: eventName,
      resaleVolume: Number.isFinite(resaleVolume) ? resaleVolume : 0,
      pricePressure,
      soldOut: Boolean(body?.sold_out ?? body?.soldOut),
      startsAt: typeof startsAt === 'string' ? startsAt : undefined,
      venueHint: typeof venueHint === 'string' ? venueHint : undefined,
    };
  }

  /**
   * Verify an inbound CrowdVolt webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded) — resale activity flows back through webhooks. Fails CLOSED:
   * mismatch, missing signature, or missing secret in production all return
   * false; the permissive path only exists in dev/stub with no secret
   * configured. Secret: connectors.crowdvoltWebhookSecret.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.crowdvoltWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'CrowdVolt webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'CrowdVolt webhook secret unset in production — rejecting webhook',
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
