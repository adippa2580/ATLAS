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
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { KlaviyoAdapter } from '../../../integrations/klaviyo.adapter';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class CreateCampaignDto {
  @IsOptional() @IsString() audienceId?: string;
  @IsOptional() @IsNumber() size?: number;
}

@Injectable()
export class LifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly klaviyo: KlaviyoAdapter,
  ) {}

  /**
   * Push a discovery notification to an audience via Klaviyo. Klaviyo is a
   * delivery rail, not a replacement for the venue's stack.
   */
  async createCampaign(ctx: TenantContext, dto: CreateCampaignDto) {
    const campaign = await this.prisma.campaign.create({
      data: {
        tenantId: ctx.tenantId,
        audienceId: dto.audienceId,
        channel: 'klaviyo',
        status: 'queued',
      },
    });

    const size = dto.size ?? 0;
    const delivery = await this.klaviyo.sendCampaign(size, {
      campaignId: campaign.id,
      audienceId: dto.audienceId ?? null,
    });

    const updated = await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: delivery.stub ? 'sent_stub' : 'sent' },
    });

    return { ...updated, delivery };
  }

  async get(ctx: TenantContext, id: string) {
    const campaign = await this.prisma.campaign.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (!campaign) {
      throw new NotFoundException('Campaign not found');
    }
    return campaign;
  }
}

@ApiTags('mkt:lifecycle')
@Controller()
export class LifecycleController {
  constructor(private readonly svc: LifecycleService) {}

  @Post('campaigns')
  @Scopes('mkt:lifecycle:write')
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateCampaignDto) {
    return this.svc.createCampaign(ctx, dto);
  }

  @Get('campaigns/:id')
  @Scopes('mkt:lifecycle:read')
  get(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.get(ctx, id);
  }
}

@Module({
  controllers: [LifecycleController],
  providers: [LifecycleService],
  exports: [LifecycleService],
})
export class LifecycleModule {}
