import { MiddlewareConsumer, Module, NestModule } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { LoggerModule } from 'nestjs-pino';
import configuration from './common/config/configuration';
import { PrismaModule } from './common/prisma/prisma.module';
import { EvidenceModule } from './common/evidence/evidence.module';
import { TenantMiddleware } from './common/tenancy/tenant.middleware';
import { HealthController } from './health.controller';
import { GuestModule } from './modules/guest/guest.module';
import { OpsModule } from './modules/ops/ops.module';
import { MarketingModule } from './modules/marketing/marketing.module';
import { McpModule } from './modules/mcp/mcp.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { StatsModule } from './stats/stats.module';

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
    DashboardModule,
    StatsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TenantMiddleware).forRoutes('*');
  }
}
