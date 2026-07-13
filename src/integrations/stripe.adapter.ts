import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

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

  /** Verify an inbound webhook signature. In stub mode, always trusts. */
  verifyWebhook(_payload: unknown, _signature?: string): boolean {
    if (this.stub) return true;
    // Real signature verification with STRIPE_WEBHOOK_SECRET would go here.
    return false;
  }

  /** Deterministic card fingerprint used to corroborate identity merges. */
  cardFingerprint(last4: string, exp: string): string {
    return `cardfp_${last4}_${exp}`;
  }
}
