import {
  Logger,
  MiddlewareConsumer,
  Module,
  NestModule,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import configuration, { AuthMode } from './common/config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { EvidenceModule } from './common/evidence/evidence.module';
import { TenantMiddleware } from './common/tenancy/tenant.middleware';
import { VenueLinkModule } from './modules/web/venue-link.module';
import { TokenVerifier } from './common/auth/token-verifier';
import { IdempotencyInterceptor } from './common/idempotency/idempotency.interceptor';
import { HealthController } from './health.controller';
import { GuestModule } from './modules/guest/guest.module';
import { OpsModule } from './modules/ops/ops.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { McpModule } from './modules/mcp/mcp.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { HomeModule } from './home/home.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { OutcomesModule } from './outcomes/outcomes.module';
import { DeliverablesModule } from './deliverables/deliverables.module';
import { StatsModule } from './stats/stats.module';
import { GraphInsightsModule } from './insights/graph/graph-insights.module';
import { RevenueInsightsModule } from './insights/revenue/revenue-insights.module';
import { OpsInsightsModule } from './insights/ops/ops-insights.module';
import { TalentModule } from './insights/talent/talent.module';
import { ProjectionModule } from './modules/guest/projection/projection.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    LoggerModule.forRoot({
      pinoHttp: {
        transport:
          process.env.NODE_ENV !== 'production'
            ? { target: 'pino-pretty' }
            : undefined,
        redact: ['req.headers.authorization', 'req.headers["x-scopes"]'],
      },
    }),
    PrismaModule,
    EvidenceModule,
    IntegrationsModule,
    GuestModule,
    OpsModule,
    MarketingModule,
    McpModule,
    // Platform home / menu at the site root, linking every surface.
    HomeModule,
    DashboardModule,
    OutcomesModule,
    // Static design deliverables (Atlas v3.1 + A-List surfaces) at /deliverables.
    DeliverablesModule,
    StatsModule,
    GraphInsightsModule,
    RevenueInsightsModule,
    OpsInsightsModule,
    TalentModule,
    // Per-venue consented projection of a guest's cross-tenant affinity (spine).
    ProjectionModule,
    // Public venue-link (class 1b) surface — tenant resolved from the link code.
    VenueLinkModule,
  ],
  controllers: [HealthController],
  providers: [
    // Verifies OAuth Bearer tokens for TenantMiddleware (AUTH_MODE=oauth).
    TokenVerifier,
    // Global defense-in-depth idempotency (engages only on Idempotency-Key).
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
})
export class AppModule implements NestModule, OnModuleInit {
  private readonly logger = new Logger(AppModule.name);

  constructor(private readonly config: ConfigService) {}

  configure(consumer: MiddlewareConsumer): void {
    consumer
      .apply(TenantMiddleware)
      .exclude('v1/venue-link/(.*)')
      .forRoutes('*');
  }

  /**
   * Startup guard: warn loudly when the trust-headers path is live in
   * production. This is intentionally NON-FATAL so the current demo keeps
   * running; flip the one-liner below to throw once OAuth is provisioned.
   */
  onModuleInit(): void {
    const authMode = this.config.get<AuthMode>('authMode') ?? 'trust-headers';
    const env = this.config.get<string>('env') ?? 'development';

    if (authMode === 'trust-headers' && env === 'production') {
      const message =
        '[SECURITY] AUTH_MODE=trust-headers in PRODUCTION: client-supplied ' +
        'X-Tenant-Id / X-Scopes headers are trusted WITHOUT token verification. ' +
        'Set AUTH_MODE=oauth (with OIDC_JWKS_URL / OIDC_ISSUER / OIDC_AUDIENCE) ' +
        'to enable real auth.';
      this.logger.error(
        '****************************************************************',
      );
      this.logger.error(message);
      this.logger.error(
        '****************************************************************',
      );
      // ESCALATION SWITCH — once OAuth is configured, uncomment to fail closed:
      // throw new Error(message);
    }
  }
}
