import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface TabPayload {
  externalTabId: string;
  total: number;
  lineItems: { name: string; amount: number }[];
  closed: boolean;
}

/**
 * Square POS adapter — tab/spend sync. The Tab/POS primitive (#13) is
 * POS-agnostic, so a Lightspeed adapter could implement the same shape.
 * STUB mode when SQUARE_ACCESS_TOKEN is unset.
 */
@Injectable()
export class SquareAdapter {
  private readonly logger = new Logger(SquareAdapter.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Verify an inbound Square webhook signature. Square signs
   * `HMAC-SHA256(signatureKey, notificationUrl + rawBody)` and sends it,
   * base64-encoded, in the `x-square-hmacsha256-signature` header.
   *
   * Fails CLOSED: a mismatch, a missing signature/url, or a missing signature
   * key in production all return false. The permissive stub/dev path is only
   * taken when NO signature key is configured AND we are not in production.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
    notificationUrl?: string,
  ): boolean {
    const key = this.config.get<string>('connectors.squareWebhookSignatureKey');
    const isProd = this.config.get<string>('env') === 'production';

    if (!key) {
      if (!isProd) {
        this.logger.warn(
          'Square webhook signature key unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Square webhook signature key unset in production — rejecting webhook',
      );
      return false;
    }

    if (!signature || rawBody == null || !notificationUrl) return false;

    const body =
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', key)
      .update(notificationUrl + body, 'utf8')
      .digest('base64');
    const expectedBuf = Buffer.from(expected, 'utf8');
    const signatureBuf = Buffer.from(signature, 'utf8');

    return (
      signatureBuf.length === expectedBuf.length &&
      timingSafeEqual(signatureBuf, expectedBuf)
    );
  }

  /** Normalise a raw Square webhook body into our TabPayload (integer cents). */
  normalizeTab(body: any): TabPayload {
    return {
      externalTabId: body?.externalTabId ?? body?.id ?? 'tab_stub',
      total: Math.round(Number(body?.total ?? 0)),
      lineItems: Array.isArray(body?.lineItems)
        ? body.lineItems.map((item: { name: string; amount: number }) => ({
            name: item?.name,
            amount: Math.round(Number(item?.amount ?? 0)),
          }))
        : [],
      closed: Boolean(body?.closed),
    };
  }
}
