import { randomUUID } from 'crypto';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class CreatePromoterDto {
  @IsString() name!: string;
  @IsOptional() @IsString() contact?: string;
}

class MintPromoterLinkDto {
  @IsOptional() @IsString() venueId?: string;
  @IsOptional() @IsString() campaignId?: string;
}

/**
 * Promoter tracking (W6 pull-forward, Creator network capability). Ratified
 * 2026-07-21 — day-one parity item vs Fourvenues (W5 appendix).
 *
 * A promoter is a creator whose links ride the SAME attribution rails as
 * campaigns and venue-links: mint a link carrying promoterId, and every
 * booking, tab and metered take that flows through it accounts back to the
 * person. No new pipeline — the venue-link surface (class 1b) is already the
 * conversion path; this adds per-person accounting on top.
 */
@Injectable()
export class PromotersService {
  constructor(private readonly prisma: PrismaService) {}

  create(ctx: TenantContext, dto: CreatePromoterDto) {
    return this.prisma.promoter.create({
      data: { tenantId: ctx.tenantId, name: dto.name, contact: dto.contact },
    });
  }

  async mintLink(
    ctx: TenantContext,
    promoterId: string,
    dto: MintPromoterLinkDto,
  ) {
    const promoter = await this.prisma.promoter.findFirst({
      where: { id: promoterId, tenantId: ctx.tenantId, active: true },
    });
    if (!promoter) throw new NotFoundException('Promoter not found');
    const code = randomUUID().replace(/-/g, '').slice(0, 12);
    return this.prisma.attributionLink.create({
      data: {
        tenantId: ctx.tenantId,
        venueId: dto.venueId,
        campaignId: dto.campaignId,
        promoterId,
        code,
      },
    });
  }

  /** Per-promoter funnel: links → bookings → seated → tab revenue → metered take. */
  async stats(ctx: TenantContext, promoterId: string) {
    const promoter = await this.prisma.promoter.findFirst({
      where: { id: promoterId, tenantId: ctx.tenantId },
    });
    if (!promoter) throw new NotFoundException('Promoter not found');

    const links = await this.prisma.attributionLink.findMany({
      where: { tenantId: ctx.tenantId, promoterId },
    });
    const linkIds = links.map((l) => l.id);
    if (!linkIds.length) {
      return {
        promoter: { id: promoter.id, name: promoter.name },
        links: 0,
        bookings: 0,
        seated: 0,
        tabRevenue: 0,
        meteredTake: 0,
      };
    }

    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        attributionId: { in: linkIds },
        status: { not: 'cancelled' },
      },
      select: { id: true, status: true },
    });
    const bookingIds = bookings.map((b) => b.id);
    const seated = bookings.filter(
      (b) => b.status === 'seated' || b.status === 'closed',
    ).length;

    const tabs = bookingIds.length
      ? await this.prisma.tab.findMany({
          where: { tenantId: ctx.tenantId, bookingId: { in: bookingIds } },
          select: { total: true },
        })
      : [];
    const tabRevenue = tabs.reduce((sum, t) => sum + t.total, 0);

    const usage = bookingIds.length
      ? await this.prisma.usageEvent.findMany({
          where: { tenantId: ctx.tenantId, bookingId: { in: bookingIds } },
          select: { billableAmount: true },
        })
      : [];
    const meteredTake = usage.reduce((sum, u) => sum + u.billableAmount, 0);

    return {
      promoter: { id: promoter.id, name: promoter.name },
      links: links.length,
      bookings: bookings.length,
      seated,
      tabRevenue,
      meteredTake,
    };
  }

  /** Leaderboard: every active promoter ranked by attributed tab revenue. */
  async leaderboard(ctx: TenantContext) {
    const promoters = await this.prisma.promoter.findMany({
      where: { tenantId: ctx.tenantId, active: true },
    });
    const rows: Awaited<ReturnType<PromotersService['stats']>>[] = [];
    for (const p of promoters) {
      rows.push(await this.stats(ctx, p.id));
    }
    return rows.sort((a, b) => b.tabRevenue - a.tabRevenue);
  }
}

@ApiTags('marketing:promoters')
@Controller('promoters')
export class PromotersController {
  constructor(private readonly service: PromotersService) {}

  @Post()
  @Scopes('marketing:promoters:write')
  create(@Tenant() ctx: TenantContext, @Body() dto: CreatePromoterDto) {
    return this.service.create(ctx, dto);
  }

  @Post(':id/links')
  @Scopes('marketing:promoters:write')
  mintLink(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: MintPromoterLinkDto,
  ) {
    return this.service.mintLink(ctx, id, dto);
  }

  @Get(':id/stats')
  @Scopes('marketing:promoters:read')
  stats(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.stats(ctx, id);
  }

  @Get()
  @Scopes('marketing:promoters:read')
  leaderboard(@Tenant() ctx: TenantContext) {
    return this.service.leaderboard(ctx);
  }
}

@Module({
  providers: [PromotersService],
  controllers: [PromotersController],
  exports: [PromotersService],
})
export class PromotersModule {}
