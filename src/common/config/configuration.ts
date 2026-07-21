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
   * W7 take-rate, basis points. Table/ticket default 0 — the real numbers are a
   * Jack-gated decision; nothing is billed until they are set. Closeout keeps
   * its prior 5% placeholder as the default so existing behaviour is unchanged.
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
    table: parseInt(process.env.TAKE_RATE_TABLE_BPS ?? '0', 10),
    ticket: parseInt(process.env.TAKE_RATE_TICKET_BPS ?? '0', 10),
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
  },
});
