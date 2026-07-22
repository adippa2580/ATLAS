import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { TabPayload } from './square.adapter';

/**
 * Toast POS adapter — tab/spend sync. Implements the same POS-agnostic shape
 * as SquareAdapter and LightspeedAdapter, per the W3 POS decision
 * (2026-07-21): every candidate adapter ships; the anchor venue's existing
 * stack decides which one gets credentials first, never which one exists.
 *
 * STUB mode when TOAST_API_KEY is unset.
 *
 * Signature scheme (Toast webhooks, "Validating the message signature"):
 * each event carries a `toast-signature` header containing
 * HMAC-SHA256(rawBody, signingSecret), hex-encoded. Fail-closed in
 * production.
 */
export const TOAST_SIGNATURE_HEADER = 'toast-signature';
@Injectable()
export class ToastAdapter {
  private readonly logger = new Logger(ToastAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.toastApiKey');
  }

  /**
   * Verify an inbound Toast webhook signature (HMAC-SHA256 of the raw body,
   * hex-encoded). Fails CLOSED: mismatch, missing signature, or missing secret
   * in production all return false; the permissive path only exists in
   * dev/stub with no secret configured.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.toastWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        this.logger.warn(
          'Toast webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Toast webhook secret unset in production — rejecting webhook',
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
   * Normalise a raw Toast order/check webhook body into the shared TabPayload
   * (integer cents) consumed by the Tab/POS primitive. Toast nests money in
   * `checks[].selections[]` with a `price` per selection and a per-check
   * `totalAmount`; a flat `total`/`items` shape is also accepted as a
   * fallback.
   */
  normalizeTab(body: any): TabPayload {
    const checks = Array.isArray(body?.checks) ? body.checks : [];

    if (checks.length > 0) {
      const lineItems = checks.flatMap((check: any) =>
        Array.isArray(check?.selections)
          ? check.selections.map(
              (sel: {
                displayName?: string;
                name?: string;
                price?: number;
              }) => ({
                name: sel?.displayName ?? sel?.name,
                amount: Math.round(Number(sel?.price ?? 0)),
              }),
            )
          : [],
      );
      const total = checks.reduce(
        (sum: number, check: any) => sum + Number(check?.totalAmount ?? 0),
        0,
      );
      return {
        externalTabId:
          body?.externalTabId ?? body?.guid ?? body?.id ?? 'toast_tab_stub',
        total: Math.round(total),
        lineItems,
        closed: Boolean(body?.closed ?? body?.paid ?? body?.voided),
      };
    }

    const items = Array.isArray(body?.lineItems)
      ? body.lineItems
      : Array.isArray(body?.items)
        ? body.items
        : [];
    return {
      externalTabId:
        body?.externalTabId ?? body?.guid ?? body?.id ?? 'toast_tab_stub',
      total: Math.round(Number(body?.total ?? body?.totalAmount ?? 0)),
      lineItems: items.map((item: { name: string; amount: number }) => ({
        name: item?.name,
        amount: Math.round(Number(item?.amount ?? 0)),
      })),
      closed: Boolean(body?.closed ?? body?.paid),
    };
  }
}
