import { randomUUID } from 'crypto';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class MintLinkDto {
  @IsOptional() @IsString() venueId?: string;
  @IsOptional() @IsString() campaignId?: string;
}

@Injectable()
export class AttributionService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mint an attributed venue/campaign link carrying a unique tracking code. */
  mintLink(ctx: TenantContext, dto: MintLinkDto) {
    const code = randomUUID().replace(/-/g, '').slice(0, 12);
    return this.prisma.attributionLink.create({
      data: {
        tenantId: ctx.tenantId,
        venueId: dto.venueId,
        campaignId: dto.campaignId,
        code,
      },
    });
  }

  /** Reach → signup → booking → spend funnel for a venue's attributed links. */
  async funnel(ctx: TenantContext, venueId: string) {
    const links = await this.prisma.attributionLink.findMany({
      where: { tenantId: ctx.tenantId, venueId },
    });
    const linkIds = links.map((l) => l.id);

    const bookings = await this.prisma.booking.count({
      where: {
        tenantId: ctx.tenantId,
        venueId,
        attributionId: { in: linkIds },
      },
    });

    const tabs = await this.prisma.tab.findMany({
      where: {
        tenantId: ctx.tenantId,
        booking: { venueId, attributionId: { in: linkIds } },
      },
      select: { total: true },
    });
    const spend = tabs.reduce((s, t) => s + t.total, 0);

    return { venueId, links: links.length, bookings, spend };
  }
}

@ApiTags('mkt:attribution')
@Controller()
export class AttributionController {
  constructor(private readonly svc: AttributionService) {}

  @Post('attribution/link')
  @Scopes('mkt:attribution:write')
  mint(@Tenant() ctx: TenantContext, @Body() dto: MintLinkDto) {
    return this.svc.mintLink(ctx, dto);
  }

  @Get('venues/:id/funnel')
  @Scopes('mkt:attribution:read')
  funnel(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.funnel(ctx, id);
  }
}

@Module({
  controllers: [AttributionController],
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
