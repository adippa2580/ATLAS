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
   * Internal admin console (ATLAS employees). `sessionSecret` signs the session
   * cookie; `users` maps a username to its password (set via per-user repo
   * secrets — never committed). Empty `sessionSecret` or empty `users` = admin
   * login is disabled (fails closed).
   */
  admin: {
    sessionSecret: string;
    users: Record<string, string>;
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
    spotifyRedirectUrl: string;
    soundcloudClientId: string;
    soundcloudClientSecret: string;
    soundcloudRedirectUrl: string;
    appleMusicDeveloperToken: string;
    appleMusicTeamId: string;
    appleMusicKeyId: string;
    appleMusicPrivateKey: string;
    connectInviteSecret: string;
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
    bandsintownAppId: string;
    alistFeedUrl: string;
    alistFeedKey: string;
  };
}

/**
 * Normalize an Apple Music .p8 private key from env into a real PKCS#8 PEM.
 * Accepts three shapes so deploy plumbing stays sed-safe:
 *  - base64 of the whole .p8 (recommended — no newlines or sed-hostile chars)
 *  - a raw PEM with real newlines
 *  - a PEM with escaped "\n" sequences (common when pasted into an env var)
 */
function normalizeP8(raw: string | undefined): string {
  if (!raw) return '';
  if (raw.includes('BEGIN')) return raw.replace(/\\n/g, '\n');
  try {
    const decoded = Buffer.from(raw, 'base64').toString('utf8');
    if (decoded.includes('BEGIN')) return decoded;
  } catch {
    // fall through
  }
  return raw.replace(/\\n/g, '\n');
}

/**
 * Resolve an admin secret from its env var, failing closed on a value that was
 * never substituted by CI. A leftover deploy placeholder (`__ADMIN_…__`) is not
 * a real secret — returning '' for it keeps `configured` false and rejects every
 * login, instead of accepting the publicly-visible placeholder as a password.
 */
function adminSecret(raw: string | undefined): string {
  const v = (raw ?? '').trim();
  if (/^__[A-Z0-9_]+__$/.test(v)) return '';
  return v;
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
  admin: {
    // A value still wrapped in the deploy placeholder (`__X__`) means the CI
    // substitution didn't run for it — treat that as UNSET so a missed sed can
    // never ship a known credential. Same rule applies to the session secret.
    sessionSecret: adminSecret(process.env.ADMIN_SESSION_SECRET),
    // Registered ATLAS employees. Each password comes from its own repo secret;
    // an unset (or un-substituted) password drops that user — login stays closed.
    users: Object.fromEntries(
      [
        ['adrian', adminSecret(process.env.ADMIN_ADRIAN_PASSWORD)],
        ['jack', adminSecret(process.env.ADMIN_JACK_PASSWORD)],
      ].filter(([, pw]) => pw),
    ),
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
    spotifyRedirectUrl: process.env.SPOTIFY_REDIRECT_URL ?? '',
    // Phase-02 taste additions. Stub until credentials are set, same as every
    // other connector. SoundCloud is a standard OAuth2 auth-code flow; Apple
    // Music authorizes client-side via MusicKit and hands back a Music User
    // Token, so the server only needs the app-level developer token.
    soundcloudClientId: process.env.SOUNDCLOUD_CLIENT_ID ?? '',
    soundcloudClientSecret: process.env.SOUNDCLOUD_CLIENT_SECRET ?? '',
    soundcloudRedirectUrl: process.env.SOUNDCLOUD_REDIRECT_URL ?? '',
    // Apple Music: EITHER supply a pre-minted developer token, OR the signing
    // trio (Team ID + Key ID + .p8 private key) and the adapter mints + rotates
    // the ES256 developer token itself. The .p8 arrives via env with escaped
    // newlines, so unescape them back to a real PEM.
    appleMusicDeveloperToken: process.env.APPLE_MUSIC_DEVELOPER_TOKEN ?? '',
    appleMusicTeamId: process.env.APPLE_MUSIC_TEAM_ID ?? '',
    appleMusicKeyId: process.env.APPLE_MUSIC_KEY_ID ?? '',
    appleMusicPrivateKey: normalizeP8(process.env.APPLE_MUSIC_PRIVATE_KEY),
    // Signs connector invite tokens. Falls back to the Spotify client secret
    // so hardening needs no extra ops step; set CONNECT_INVITE_SECRET to
    // rotate independently.
    connectInviteSecret:
      process.env.CONNECT_INVITE_SECRET ??
      process.env.SPOTIFY_CLIENT_SECRET ??
      '',
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
    // Bandsintown artist-events API (app_id issued per partner). Complements
    // Ticketmaster with club/indie/international long-tail coverage. Stub when unset.
    bandsintownAppId: process.env.BANDSINTOWN_APP_ID ?? '',
    // ALIST partner feed: public ra_events table (RA + Ticketmaster, refreshed
    // by A-List's ra-cron). Key is the publishable anon key — client-safe class.
    alistFeedUrl: process.env.ALIST_FEED_URL ?? '',
    alistFeedKey: process.env.ALIST_FEED_KEY ?? '',
  },
});
