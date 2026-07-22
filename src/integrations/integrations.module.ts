import { Global, Module } from '@nestjs/common';
import { StripeAdapter } from './stripe.adapter';
import { SquareAdapter } from './square.adapter';
import { SpotifyAdapter } from './spotify.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { KlaviyoAdapter } from './klaviyo.adapter';
import { LightspeedAdapter } from './lightspeed.adapter';

/**
 * Connector adapters for the first five integrations (W3). Each is a thin
 * adapter over an external API; when the corresponding credential is unset they
 * run in STUB mode and return deterministic canned data so the whole platform
 * boots and the loops are exercisable without cloud/vendor credentials.
 */
@Global()
@Module({
  providers: [
    StripeAdapter,
    SquareAdapter,
    SpotifyAdapter,
    InstagramAdapter,
    KlaviyoAdapter,
    LightspeedAdapter,
  ],
  exports: [
    StripeAdapter,
    SquareAdapter,
    SpotifyAdapter,
    InstagramAdapter,
    KlaviyoAdapter,
    LightspeedAdapter,
  ],
})
export class IntegrationsModule {}
