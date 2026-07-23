import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Scopes } from '../common/auth/scopes.decorator';

const BOOT_TIME = Date.now();

/**
 * The OS "About" surface — ATLAS is an operating system, so it can introduce
 * itself like one. Reports which connectors are LIVE vs STUB (presence of
 * config only — never values), what the kernel is running, and for how long.
 * Feeds the console's system bar.
 */
@Injectable()
export class SystemService {
  constructor(private readonly config: ConfigService) {}

  private mode(key: string): 'live' | 'stub' {
    return this.config.get<string>(key) ? 'live' : 'stub';
  }

  about() {
    const uptimeS = Math.floor((Date.now() - BOOT_TIME) / 1000);
    return {
      os: 'ATLAS',
      tagline: 'The platform underneath the experience',
      kernel: process.env.npm_package_version ?? '0.1.0',
      env: this.config.get<string>('env') ?? 'development',
      hubs: ['guest', 'ops', 'marketing'],
      primitives: 23,
      evidenceBus: this.config.get<string>('evidenceBus') ?? 'memory',
      authMode: this.config.get<string>('authMode') ?? 'trust-headers',
      uptimeSeconds: uptimeS,
      connectors: {
        spotify: this.mode('connectors.spotifyClientId'),
        instagram: this.mode('connectors.instagramClientId'),
        klaviyo: this.mode('connectors.klaviyoApiKey'),
        stripe: this.mode('connectors.stripeSecretKey'),
        square: this.mode('connectors.squareAccessToken'),
        lightspeed: this.mode('connectors.lightspeedApiKey'),
        eventsFeed:
          this.config.get<string>('connectors.alistFeedKey') ||
          this.config.get<string>('connectors.ticketmasterApiKey')
            ? 'live'
            : 'stub',
      },
    };
  }
}

@ApiTags('system')
@Controller('system')
export class SystemController {
  constructor(private readonly svc: SystemService) {}

  @Get()
  @Scopes('mkt:reporting:read')
  about() {
    return this.svc.about();
  }
}

@Module({
  providers: [SystemService],
  controllers: [SystemController],
  exports: [SystemService],
})
export class SystemModule {}
