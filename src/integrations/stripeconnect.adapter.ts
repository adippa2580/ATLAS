import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface ConnectedAccountResult {
  accountId: string;
  onboardingUrl: string;
  status: string;
}

export interface TransferResult {
  transferId: string;
  amount: number;
  status: string;
}

export interface NormalizedPayout {
  externalPayoutId: string;
  accountId: string;
  amountCents: number;
  status: 'paid' | 'in_transit' | 'failed';
}

/**
 * Stripe Connect adapter — the account + transfer/payout rails that sit on top
 * of the core {@link StripeAdapter} (PaymentIntents). Where StripeAdapter
 * collects money into ATLAS, this adapter routes it back out to venues.
 *
 * ATLAS mapping:
 * - An A-List booking is paid for by a crew: each crew member settles their own
 *   portion (SplitGroup → Payment) through PaymentIntents on the core adapter.
 * - Collected funds are routed to the hosting venue via its Stripe **connected
 *   account** ({@link createConnectedAccount}) using platform **transfers**
 *   ({@link createTransfer}).
 * - ATLAS commission / booking fees are taken as an **application fee**
 *   ({@link applicationFeeCents}) — always computed in integer cents.
 * - Booking completion, abandonment, refunds and chargebacks flow back to Atlas
 *   as payout webhooks ({@link normalizePayout}) reconciled against the venue's
 *   connected account.
 *
 * STUB-first: when `connectors.stripeConnectClientId` is unset the adapter
 * returns deterministic, unique canned results and never touches the network.
 * Live mode is gated on that config and is intentionally unimplemented in this
 * build.
 *
 * Built for KAN-13.
 */
@Injectable()
export class StripeConnectAdapter {
  private readonly logger = new Logger(StripeConnectAdapter.name);

  constructor(private readonly config: ConfigService) {}

  private get stub(): boolean {
    return !this.config.get<string>('connectors.stripeConnectClientId');
  }

  /**
   * Create (or begin onboarding) a Stripe connected account for a venue so it
   * can receive payouts. Stub returns a deterministic `acct_stub_<venueId>` id
   * plus an onboarding URL and a `pending` status.
   */
  async createConnectedAccount(
    venueId: string,
  ): Promise<ConnectedAccountResult> {
    if (this.stub) {
      const accountId = `acct_stub_${venueId}`;
      return {
        accountId,
        onboardingUrl: `https://connect.stripe.com/setup/s/stub/${venueId}`,
        status: 'pending',
      };
    }
    // Real Stripe Connect account + AccountLink creation would go here.
    this.logger.debug(`Stripe Connect createConnectedAccount ${venueId}`);
    throw new Error('Stripe Connect live mode not configured in this build');
  }

  /**
   * Transfer collected funds to a venue's connected account. Idempotency is
   * keyed on the FULL `idempotencyKey`, so the stub id is unique per key.
   * `amount` echoes back the requested integer-cent amount unchanged.
   */
  async createTransfer(
    amountCents: number,
    destinationAccountId: string,
    idempotencyKey: string,
  ): Promise<TransferResult> {
    if (this.stub) {
      return {
        transferId: `tr_stub_${idempotencyKey}`,
        amount: amountCents,
        status: 'pending',
      };
    }
    // Real Stripe transfers.create({ destination, transfer_group }) goes here.
    this.logger.debug(
      `Stripe Connect createTransfer ${amountCents} → ${destinationAccountId}`,
    );
    throw new Error('Stripe Connect live mode not configured in this build');
  }

  /**
   * Compute the ATLAS application fee for a transfer, in integer cents. Money is
   * never a float: `feeBps` is basis points (1 bp = 0.01%), so 1000 bps = 10%.
   */
  applicationFeeCents(amountCents: number, feeBps: number): number {
    return Math.round((amountCents * feeBps) / 10000);
  }

  /**
   * Normalise a raw Stripe payout webhook body into ATLAS's shape. Defensive
   * over the field variants Stripe (and our own re-emitters) use, and coerces
   * the amount to integer cents.
   */
  normalizePayout(body: any): NormalizedPayout {
    const rawStatus = String(body?.status ?? '');
    const status: NormalizedPayout['status'] =
      rawStatus === 'paid' || rawStatus === 'in_transit' ? rawStatus : 'failed';
    return {
      externalPayoutId: String(
        body?.id ?? body?.payout_id ?? body?.payoutId ?? 'po_stub',
      ),
      accountId: String(
        body?.destination ?? body?.account ?? body?.accountId ?? '',
      ),
      amountCents: Math.round(Number(body?.amount ?? body?.amountCents ?? 0)),
      status,
    };
  }
}
