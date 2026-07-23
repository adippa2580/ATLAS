import { Global, Module } from '@nestjs/common';
import { StripeAdapter } from './stripe.adapter';
import { SquareAdapter } from './square.adapter';
import { SpotifyAdapter } from './spotify.adapter';
import { SoundcloudAdapter } from './soundcloud.adapter';
import { AppleMusicAdapter } from './applemusic.adapter';
import { InstagramAdapter } from './instagram.adapter';
import { KlaviyoAdapter } from './klaviyo.adapter';
import { LightspeedAdapter } from './lightspeed.adapter';
import { ToastAdapter } from './toast.adapter';
import { SevenroomsAdapter } from './sevenrooms.adapter';
import { ResyAdapter } from './resy.adapter';
import { TockAdapter } from './tock.adapter';
import { EventbriteAdapter } from './eventbrite.adapter';
import { GoogleCalendarAdapter } from './gcal.adapter';
import { EventsFeedAdapter } from './eventsfeed.adapter';
// Product-MVP connector fleet (KAN-4..KAN-13) — all stub-first.
import { GigfinesseAdapter } from './gigfinesse.adapter';
import { CobrandAdapter } from './cobrand.adapter';
import { FourvenuesAdapter } from './fourvenues.adapter';
import { SoundchartsAdapter } from './soundcharts.adapter';
import { PoshAdapter } from './posh.adapter';
import { DiceAdapter } from './dice.adapter';
import { ResidentAdvisorAdapter } from './residentadvisor.adapter';
import { CrowdvoltAdapter } from './crowdvolt.adapter';
import { TablelistAdapter } from './tablelist.adapter';
import { StripeConnectAdapter } from './stripeconnect.adapter';

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
    SoundcloudAdapter,
    AppleMusicAdapter,
    InstagramAdapter,
    KlaviyoAdapter,
    LightspeedAdapter,
    EventsFeedAdapter,
    ToastAdapter,
    SevenroomsAdapter,
    ResyAdapter,
    TockAdapter,
    EventbriteAdapter,
    GoogleCalendarAdapter,
    GigfinesseAdapter,
    CobrandAdapter,
    FourvenuesAdapter,
    SoundchartsAdapter,
    PoshAdapter,
    DiceAdapter,
    ResidentAdvisorAdapter,
    CrowdvoltAdapter,
    TablelistAdapter,
    StripeConnectAdapter,
  ],
  exports: [
    StripeAdapter,
    SquareAdapter,
    SpotifyAdapter,
    SoundcloudAdapter,
    AppleMusicAdapter,
    InstagramAdapter,
    KlaviyoAdapter,
    LightspeedAdapter,
    EventsFeedAdapter,
    ToastAdapter,
    SevenroomsAdapter,
    ResyAdapter,
    TockAdapter,
    EventbriteAdapter,
    GoogleCalendarAdapter,
    GigfinesseAdapter,
    CobrandAdapter,
    FourvenuesAdapter,
    SoundchartsAdapter,
    PoshAdapter,
    DiceAdapter,
    ResidentAdvisorAdapter,
    CrowdvoltAdapter,
    TablelistAdapter,
    StripeConnectAdapter,
  ],
})
export class IntegrationsModule {}
