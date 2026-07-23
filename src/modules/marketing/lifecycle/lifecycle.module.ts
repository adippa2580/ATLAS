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

    // Resolve the audience's stored matched-guest set to real contact keys so
    // the campaign actually delivers in live mode. Audiences built by the
    // recommendation rail stash `matchedGuestIds` in their predicates.
    const recipients = await this.resolveRecipients(ctx, dto.audienceId);
    const size = dto.size ?? recipients.length;
    const delivery = await this.klaviyo.sendCampaign(
      size,
      {
        template: 'lifecycle_campaign',
        campaignId: campaign.id,
        audienceId: dto.audienceId ?? null,
      },
      recipients,
    );

    const updated = await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: delivery.stub ? 'sent_stub' : 'sent' },
    });

    return { ...updated, delivery };
  }

  /** Contact keys for an audience's stored matched-guest set (empty if none). */
  private async resolveRecipients(ctx: TenantContext, audienceId?: string) {
    if (!audienceId) return [];
    const audience = await this.prisma.audience.findFirst({
      where: { id: audienceId, tenantId: ctx.tenantId },
    });
    const predicates = audience?.predicates as {
      matchedGuestIds?: unknown;
    } | null;
    const guestIds = Array.isArray(predicates?.matchedGuestIds)
      ? predicates.matchedGuestIds.filter(
          (x): x is string => typeof x === 'string',
        )
      : [];
    if (!guestIds.length) return [];
    const guests = await this.prisma.guest.findMany({
      where: { tenantId: ctx.tenantId, id: { in: guestIds } },
      select: { id: true, email: true, primaryPhone: true, displayName: true },
    });
    return KlaviyoAdapter.toRecipients(guests, { audienceId });
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
