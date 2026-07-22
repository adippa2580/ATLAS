/**
 * How the platform resolves a request's TenantContext.
 *  - 'trust-headers': legacy/dev path — trust X-Tenant-Id / X-Scopes headers.
 *    This is the currently-live demo behavior and remains the DEFAULT so nothing
 *    breaks until OAuth is provisioned.
 *  - 'oauth': verify a Bearer JWT against a remote JWKS (see token-verifier.ts)
 *    and derive the TenantContext from the token's claims.
 */
export type AuthMode = 'trust-headers' | 'oauth';

export interface AppConfig {
  env: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  evidenceBus: 'memory' | 'pubsub';
  gcpProjectId: string;
  pubsubEvidenceTopic: string;
  devTrustHeaders: boolean;
  authMode: AuthMode;
  oidc: {
    jwksUrl: string;
    issuer: string;
    audience: string;
  };
  /**
   * W7 take-rate, basis points. Table 1000 (10%) / ticket 800 (8%) are the
   * W7 one-pager PLACEHOLDER numbers, adopted 2026-07-21 pending Jack — set
   * the ratified values via env before any venue conversation. Closeout keeps
   * its prior 5% placeholder as the tab-fallback default.
   */
  takeRateBps: {
    table: number;
    ticket: number;
    closeout: number;
  };
  connectors: {
    stripeSecretKey: string;
    stripeWebhookSecret: string;
    spotifyClientId: string;
    spotifyClientSecret: string;
    instagramClientId: string;
    instagramClientSecret: string;
    klaviyoApiKey: string;
    squareAccessToken: string;
    squareWebhookSignatureKey: string;
    lightspeedApiKey: string;
    lightspeedWebhookSecret: string;
    toastApiKey: string;
    toastWebhookSecret: string;
    sevenroomsApiKey: string;
    sevenroomsWebhookSecret: string;
    resyApiKey: string;
    resyWebhookSecret: string;
    tockApiKey: string;
    tockWebhookSecret: string;
    eventbriteApiToken: string;
    googleCalendarClientId: string;
    googleCalendarClientSecret: string;
    ticketmasterApiKey: string;
  };
}

export default (): AppConfig => ({
  env: process.env.NODE_ENV ?? 'development',
  port: parseInt(process.env.PORT ?? '3000', 10),
  databaseUrl: process.env.DATABASE_URL ?? '',
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  evidenceBus: (process.env.EVIDENCE_BUS as 'memory' | 'pubsub') ?? 'memory',
  gcpProjectId: process.env.GCP_PROJECT_ID ?? '',
  pubsubEvidenceTopic: process.env.PUBSUB_EVIDENCE_TOPIC ?? 'atlas-evidence',
  devTrustHeaders: (process.env.DEV_TRUST_HEADERS ?? 'true') === 'true',
  // DEFAULT 'trust-headers' keeps the live demo working with no env changes.
  // Set AUTH_MODE=oauth (plus OIDC_* below) to enable real token verification.
  authMode: (process.env.AUTH_MODE as AuthMode) ?? 'trust-headers',
  oidc: {
    jwksUrl: process.env.OIDC_JWKS_URL ?? '',
    issuer: process.env.OIDC_ISSUER ?? '',
    audience: process.env.OIDC_AUDIENCE ?? '',
  },
  takeRateBps: {
    table: parseInt(process.env.TAKE_RATE_TABLE_BPS ?? '1000', 10),
    ticket: parseInt(process.env.TAKE_RATE_TICKET_BPS ?? '800', 10),
    closeout: parseInt(process.env.TAKE_RATE_CLOSEOUT_BPS ?? '500', 10),
  },
  connectors: {
    stripeSecretKey: process.env.STRIPE_SECRET_KEY ?? '',
    stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET ?? '',
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID ?? '',
    spotifyClientSecret: process.env.SPOTIFY_CLIENT_SECRET ?? '',
    instagramClientId: process.env.INSTAGRAM_CLIENT_ID ?? '',
    instagramClientSecret: process.env.INSTAGRAM_CLIENT_SECRET ?? '',
    klaviyoApiKey: process.env.KLAVIYO_API_KEY ?? '',
    squareAccessToken: process.env.SQUARE_ACCESS_TOKEN ?? '',
    squareWebhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY ?? '',
    // W3 POS decision (2026-07-21): both POS options ship; Lightspeed runs in
    // stub mode until the anchor conversation assigns credentials.
    lightspeedApiKey: process.env.LIGHTSPEED_API_KEY ?? '',
    lightspeedWebhookSecret: process.env.LIGHTSPEED_WEBHOOK_SECRET ?? '',
    // POS + reservation + demand connectors. All run in STUB mode until the
    // matching credential is set; the anchor venue's existing stack decides
    // which gets real credentials first, never which one exists.
    toastApiKey: process.env.TOAST_API_KEY ?? '',
    toastWebhookSecret: process.env.TOAST_WEBHOOK_SECRET ?? '',
    sevenroomsApiKey: process.env.SEVENROOMS_API_KEY ?? '',
    sevenroomsWebhookSecret: process.env.SEVENROOMS_WEBHOOK_SECRET ?? '',
    resyApiKey: process.env.RESY_API_KEY ?? '',
    resyWebhookSecret: process.env.RESY_WEBHOOK_SECRET ?? '',
    tockApiKey: process.env.TOCK_API_KEY ?? '',
    tockWebhookSecret: process.env.TOCK_WEBHOOK_SECRET ?? '',
    eventbriteApiToken: process.env.EVENTBRITE_API_TOKEN ?? '',
    googleCalendarClientId: process.env.GOOGLE_CALENDAR_CLIENT_ID ?? '',
    googleCalendarClientSecret: process.env.GOOGLE_CALENDAR_CLIENT_SECRET ?? '',
    // Class-3 catalog feed (events/venues). Stub slate when unset.
    ticketmasterApiKey: process.env.TICKETMASTER_API_KEY ?? '',
  },
});
