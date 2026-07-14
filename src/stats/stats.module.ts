import { Controller, Get, Injectable, Module } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../common/prisma/prisma.service';
import { Scopes } from '../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../common/tenancy/tenant-context';

/**
 * Platform totals for the operations console — tenant-scoped counts plus the
 * global entity catalog and summed POS spend. Read-only.
 */
@Injectable()
export class StatsService {
  constructor(private readonly prisma: PrismaService) {}

  async overview(ctx: TenantContext) {
    const t = ctx.tenantId;
    const [
      guests,
      evidence,
      affinities,
      crews,
      bookings,
      payments,
      entitlements,
      audiences,
      campaigns,
      venues,
      inventory,
      consents,
      usage,
      entities,
      spend,
    ] = await Promise.all([
      this.prisma.guest.count({ where: { tenantId: t } }),
      this.prisma.affinityEvidence.count({ where: { tenantId: t } }),
      this.prisma.guestAffinity.count({ where: { tenantId: t } }),
      this.prisma.crew.count({ where: { tenantId: t } }),
      this.prisma.booking.count({ where: { tenantId: t } }),
      this.prisma.payment.count({ where: { tenantId: t } }),
      this.prisma.entitlement.count({ where: { tenantId: t } }),
      this.prisma.audience.count({ where: { tenantId: t } }),
      this.prisma.campaign.count({ where: { tenantId: t } }),
      this.prisma.venue.count({ where: { tenantId: t } }),
      this.prisma.inventory.count({ where: { tenantId: t } }),
      this.prisma.consentGrant.count({ where: { tenantId: t } }),
      this.prisma.usageEvent.count({ where: { tenantId: t } }),
      this.prisma.entity.count(),
      this.prisma.tab.aggregate({
        where: { tenantId: t },
        _sum: { total: true },
      }),
    ]);
    return {
      tenantId: t,
      guests,
      evidence,
      affinities,
      crews,
      bookings,
      payments,
      entitlements,
      audiences,
      campaigns,
      venues,
      inventory,
      consents,
      usageEvents: usage,
      entities,
      totalSpend: spend._sum.total ?? 0,
    };
  }
}

@ApiTags('stats')
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) {}

  @Get()
  @Scopes('mkt:reporting:read')
  overview(@Tenant() ctx: TenantContext) {
    return this.stats.overview(ctx);
  }
}

@Module({
  controllers: [StatsController],
  providers: [StatsService],
})
export class StatsModule {}
