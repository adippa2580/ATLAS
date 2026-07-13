export interface AppConfig {
  env: string;
  port: number;
  databaseUrl: string;
  redisUrl: string;
  evidenceBus: 'memory' | 'pubsub';
  gcpProjectId: string;
  pubsubEvidenceTopic: string;
  devTrustHeaders: boolean;
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
