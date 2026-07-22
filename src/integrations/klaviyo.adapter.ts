import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * A single deliverable target. At least one of email / phone / externalId must
 * be present or the recipient is dropped (Klaviyo needs a profile key). `phone`
 * is E.164; `externalId` is the Atlas guestId, mapped to the Klaviyo profile's
 * external_id so a venue that syncs its own profiles still resolves the person.
 */
export interface KlaviyoRecipient {
  email?: string | null;
  phone?: string | null;
  externalId?: string | null;
  properties?: Record<string, unknown>;
}

export interface DeliveryResult {
  delivered: number;
  provider: 'klaviyo';
  stub: boolean;
  /** Live mode only: recipients dropped for no contact key or a failed send. */
  skipped?: number;
  /** Live mode only: why `delivered` is 0 (e.g. no contactable recipients). */
  reason?: string;
}

/**
 * Klaviyo adapter — CRM/email delivery rail. Makes the venue's existing stack
 * smarter (no rip-and-replace).
 *
 * Delivery is DISCOVERY, never a blast: in live mode we push one metric *event*
 * per consented recipient to Klaviyo's server-side Events API. The venue's own
 * Klaviyo flows subscribe to that metric and decide the actual message — the
 * marketer keeps control of copy, timing, and suppression. Atlas never creates
 * or sends a campaign to a list, so this cannot become a mass blast.
 *
 * STUB mode (no KLAVIYO_API_KEY): logs the intent and reports the audience size
 * as delivered, so the whole recommend → act loop is exercisable without creds.
 *
 * Fail-soft: a send is a side effect of a discovery action, so a Klaviyo outage
 * or a recipient with no contact key must never surface as a 5xx on the caller's
 * action. We count what got through and report the rest as `skipped`; we never
 * throw out of sendCampaign.
 */
@Injectable()
export class KlaviyoAdapter {
  private readonly logger = new Logger(KlaviyoAdapter.name);

  // Klaviyo API surface. The revision header is REQUIRED and version-pins the
  // request/response shape; bump deliberately, not incidentally.
  private static readonly BASE_URL = 'https://a.klaviyo.com/api';
  private static readonly REVISION = '2024-10-15';
  private static readonly REQUEST_TIMEOUT_MS = 10_000;
  // Bounded fan-out + a safety ceiling so a runaway audience can't spray the
  // Events API. A larger audience is truncated (and logged), never silently
  // dropped whole.
  private static readonly CONCURRENCY = 5;
  private static readonly MAX_RECIPIENTS = 5_000;

  // template → Klaviyo metric name. The venue builds one flow per metric, so
  // these names are the integration contract with the marketer's Klaviyo account.
  private static readonly METRIC_BY_TEMPLATE: Record<string, string> = {
    event_promo: 'Atlas Event Match',
    regulars_lock_in: 'Atlas Regulars Lock-In',
    lapsed_vip_winback: 'Atlas Winback',
    crew_rebook_nudge: 'Atlas Crew Rebook',
    post_visit_loyalty_claim: 'Atlas Loyalty Claim',
  };

  constructor(private readonly config: ConfigService) {}

  private get apiKey(): string {
    return this.config.get<string>('connectors.klaviyoApiKey') ?? '';
  }

  private get stub(): boolean {
    return !this.apiKey;
  }

  private metricName(payload: Record<string, unknown>): string {
    const template =
      typeof payload.template === 'string' ? payload.template : '';
    return KlaviyoAdapter.METRIC_BY_TEMPLATE[template] ?? 'Atlas Signal';
  }

  /**
   * Map guest rows to recipients. Kept as a pure static helper so callers own
   * the tenant-scoped, consent-filtered DB read (the adapter itself stays
   * config-only, like every other adapter). Guests with neither an email nor a
   * phone are still emitted with their externalId — Klaviyo can resolve them if
   * the venue syncs profiles by external_id, and they are dropped at send time
   * otherwise.
   */
  static toRecipients(
    guests: {
      id: string;
      email?: string | null;
      primaryPhone?: string | null;
      displayName?: string | null;
    }[],
    properties: Record<string, unknown> = {},
  ): KlaviyoRecipient[] {
    return guests.map((g) => ({
      email: g.email ?? null,
      phone: g.primaryPhone ?? null,
      externalId: g.id,
      properties: g.displayName
        ? { ...properties, guestName: g.displayName }
        : properties,
    }));
  }

  async sendCampaign(
    audienceSize: number,
    payload: Record<string, unknown>,
    recipients?: KlaviyoRecipient[],
  ): Promise<DeliveryResult> {
    if (this.stub) {
      this.logger.debug(
        `[klaviyo-stub] would deliver to ${audienceSize} recipients: ${JSON.stringify(payload)}`,
      );
      return { delivered: audienceSize, provider: 'klaviyo', stub: true };
    }

    const metric = this.metricName(payload);

    // A contactable recipient has at least one profile key. Without a recipient
    // list (legacy callers) there is nothing to send to — report it plainly
    // rather than pretend, and never throw.
    const contactable = (recipients ?? []).filter(
      (r) => r.email || r.phone || r.externalId,
    );
    if (!contactable.length) {
      this.logger.warn(
        `[klaviyo] live mode but no contactable recipients for metric "${metric}" — nothing sent`,
      );
      return {
        delivered: 0,
        provider: 'klaviyo',
        stub: false,
        reason: 'no contactable recipients',
      };
    }

    let targets = contactable;
    if (targets.length > KlaviyoAdapter.MAX_RECIPIENTS) {
      this.logger.warn(
        `[klaviyo] ${targets.length} recipients exceeds cap ${KlaviyoAdapter.MAX_RECIPIENTS} for metric "${metric}" — truncating`,
      );
      targets = targets.slice(0, KlaviyoAdapter.MAX_RECIPIENTS);
    }

    let delivered = 0;
    for (let i = 0; i < targets.length; i += KlaviyoAdapter.CONCURRENCY) {
      const batch = targets.slice(i, i + KlaviyoAdapter.CONCURRENCY);
      const results = await Promise.all(
        batch.map((r) => this.trackEvent(metric, r, payload)),
      );
      delivered += results.filter(Boolean).length;
    }

    const skipped = contactable.length - delivered;
    if (skipped > 0) {
      this.logger.warn(
        `[klaviyo] metric "${metric}": ${delivered} delivered, ${skipped} skipped`,
      );
    }
    return { delivered, provider: 'klaviyo', stub: false, skipped };
  }

  /**
   * Push a single metric event for one profile. Returns true on a 2xx, false on
   * any error — the caller aggregates, so one bad recipient never fails the run.
   */
  private async trackEvent(
    metric: string,
    recipient: KlaviyoRecipient,
    payload: Record<string, unknown>,
  ): Promise<boolean> {
    const profile: Record<string, unknown> = {};
    if (recipient.email) profile.email = recipient.email;
    if (recipient.phone) profile.phone_number = recipient.phone;
    if (recipient.externalId) profile.external_id = recipient.externalId;

    const body = {
      data: {
        type: 'event',
        attributes: {
          properties: { ...payload, ...(recipient.properties ?? {}) },
          metric: {
            data: { type: 'metric', attributes: { name: metric } },
          },
          profile: { data: { type: 'profile', attributes: profile } },
        },
      },
    };

    try {
      const res = await fetch(`${KlaviyoAdapter.BASE_URL}/events/`, {
        method: 'POST',
        headers: {
          Authorization: `Klaviyo-API-Key ${this.apiKey}`,
          revision: KlaviyoAdapter.REVISION,
          accept: 'application/vnd.api+json',
          'content-type': 'application/vnd.api+json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(KlaviyoAdapter.REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.logger.warn(
          `[klaviyo] event "${metric}" -> ${res.status} for ${recipient.email ?? recipient.phone ?? recipient.externalId}`,
        );
        return false;
      }
      return true;
    } catch (err) {
      this.logger.warn(
        `[klaviyo] event "${metric}" failed: ${(err as Error).message}`,
      );
      return false;
    }
  }
}
