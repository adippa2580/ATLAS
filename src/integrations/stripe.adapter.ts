import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface PaymentIntentResult {
  id: string;
  clientSecret: string;
  status: string;
}

/**
 * Stripe adapter — payments, split-pay PaymentIntents, and the card fingerprint
 * used to corroborate identity merges. STUB mode when STRIPE_SECRET_KEY is unset.
 */
@Injectable()
export class StripeAdapter {
  private readonly logger = new Logger(StripeAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.stripeSecretKey');
  }

  async createPaymentIntent(
    amount: number,
    idempotencyKey: string,
  ): Promise<PaymentIntentResult> {
    if (this.stub) {
      return {
        id: `pi_stub_${idempotencyKey.slice(0, 12)}`,
        clientSecret: `pi_stub_secret_${idempotencyKey.slice(0, 8)}`,
        status: 'requires_payment_method',
      };
    }
    // Real Stripe SDK call would go here.
    this.logger.debug(`Stripe createPaymentIntent ${amount}`);
    throw new Error('Stripe live mode not configured in this build');
  }

  /**
   * Verify an inbound Stripe webhook signature over the RAW request bytes.
   *
   * Fails CLOSED: a mismatch, a missing signature, or a missing secret in
   * production all return false. The permissive stub/dev path is only taken
   * when NO webhook secret is configured AND we are not in production.
   */
  verifyWebhook(
    rawBody: Buffer | string | undefined,
    signature?: string,
  ): boolean {
    const secret = this.config.get<string>('connectors.stripeWebhookSecret');
    const isProd = this.config.get<string>('env') === 'production';

    if (!secret) {
      if (!isProd) {
        // Explicit stub/dev mode: no secret configured, not production.
        this.logger.warn(
          'Stripe webhook secret unset — trusting webhook in dev/stub mode',
        );
        return true;
      }
      this.logger.error(
        'Stripe webhook secret unset in production — rejecting webhook',
      );
      return false;
    }

    if (!signature || rawBody == null) return false;

    // Stripe-Signature header: "t=<timestamp>,v1=<sig>[,v1=<sig>...]".
    let timestamp: string | undefined;
    const v1Signatures: string[] = [];
    for (const part of signature.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (key === 't') timestamp = value;
      else if (key === 'v1') v1Signatures.push(value);
    }
    if (!timestamp || v1Signatures.length === 0) return false;

    const body =
      typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = createHmac('sha256', secret)
      .update(`${timestamp}.${body}`, 'utf8')
      .digest('hex');
    const expectedBuf = Buffer.from(expected, 'utf8');

    // Constant-time compare against each provided v1 signature.
    return v1Signatures.some((sig) => {
      const sigBuf = Buffer.from(sig, 'utf8');
      return (
        sigBuf.length === expectedBuf.length &&
        timingSafeEqual(sigBuf, expectedBuf)
      );
    });
  }

  /** Deterministic card fingerprint used to corroborate identity merges. */
  cardFingerprint(last4: string, exp: string): string {
    return `cardfp_${last4}_${exp}`;
  }
}
