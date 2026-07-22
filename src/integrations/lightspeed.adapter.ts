import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TabPayload } from './square.adapter';

/**
 * Lightspeed POS adapter (K-Series Restaurant) — tab/spend sync. Implements
 * the same POS-agnostic shape as SquareAdapter, per the W3 POS decision
 * (2026-07-21): BOTH options ship; the anchor venue's existing stack decides
 * which adapter gets credentials first, never which one exists.
 *
 * STUB mode when LIGHTSPEED_API_KEY is unset.
 *
 * Signature scheme (verified against the Kounta-by-Lightspeed API docs —
 * Kounta is the K in K-Series; apidoc.kounta.com/webhooks "Verifying
 * webhooks"): each event carries an `X-Kounta-Signature` header containing
 * HMAC-SHA256(rawBody, signatureToken), hex-encoded. No URL prefixing
 * (unlike Square). Fail-closed in production.
 */
export const LIGHTSPEED_SIGNATURE_HEADER = 'x-kounta-signature';
@Injectable()
export class LightspeedAdapter {
  private readonly logger = new Logger(LightspeedAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.lightspeedApiKey');
  }

  /**
   * Verify an inbound Lightspeed webhook signature (HMAC-SHA256 of the raw
   * body, hex-encoded). Fails CLOSED: mismatch, missing signature, or missing
   * secret in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>(
      'connectors.lightspeedWebhookSecret',
    );
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'Lightspeed webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Lightspeed webhook secret unset in production — rejecting webhook',
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
   * Normalise a raw Lightspeed K-Series order/payment webhook body into the
   * shared TabPayload (integer cents) consumed by the Tab/POS primitive.
   */
  normalizeTab(body: any): TabPayload {
    const items = Array.isArray(body?.lineItems)
      ? body.lineItems
      : Array.isArray(body?.items)
        ? body.items
        : [];
    return {
      externalTabId:
        body?.externalTabId ?? body?.orderId ?? body?.id ?? 'ls_tab_stub',
      total: Math.round(Number(body?.total ?? body?.totalAmount ?? 0)),
      lineItems: items.map((item: { name: string; amount: number }) => ({
        name: item?.name,
        amount: Math.round(Number(item?.amount ?? 0)),
      })),
      closed: Boolean(body?.closed ?? body?.finalized),
    };
  }
}
