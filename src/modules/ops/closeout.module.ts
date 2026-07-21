import {
  Body,
  Controller,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { KlaviyoAdapter } from '../../integrations/klaviyo.adapter';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { AvailabilityService } from './availability.service';

class CloseoutDto {
  @IsOptional() @IsString() date?: string;
}

/**
 * Closeout / Settlement (#16) — nightly reconciliation. Sums the night's
 * bookings and tabs, meters a `usage_event` whose billableAmount is the
 * configured take-rate of total tab spend (TAKE_RATE_CLOSEOUT_BPS, default
 * 500 = the prior 5% placeholder), and fires the V4 post-visit loyalty
 * message to venue-link-acquired provisional guests — the second app
 * conversion window (journey W2 §V4).
 */
@Injectable()
export class CloseoutService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly klaviyo: KlaviyoAdapter,
  ) {}

  async closeout(ctx: TenantContext, venueId: string, dto: CloseoutDto) {
    const range = AvailabilityService.dayRange(dto.date);

    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        venueId,
        ...(range ? { date: range } : {}),
      },
      include: { tab: true },
    });

    // All money is integer minor units (cents). totalTab is a sum of integer
    // cents; the take-rate is bps-scaled and rounded back to integer cents.
    const bps = this.config.get<number>('takeRateBps.closeout') ?? 500;
    const totalTab = bookings.reduce((sum, b) => sum + (b.tab?.total ?? 0), 0);
    const takeRate = Math.round((totalTab * bps) / 10_000);

    const usage = await this.prisma.usageEvent.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'booking',
        billableAmount: takeRate,
      },
    });

    // V4 — post-visit conversion window: venue-link guests who are still
    // provisional get the loyalty-claim message ("You earned credit at
    // {venue} — claim it in A-List"). Stub rail logs; live rail is Klaviyo.
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, tenantId: ctx.tenantId },
    });
    const guestIds = [...new Set(bookings.map((b) => b.guestId))];
    const provisionalGuests = guestIds.length
      ? await this.prisma.guest.findMany({
          where: {
            tenantId: ctx.tenantId,
            id: { in: guestIds },
            provisional: true,
            primaryPhone: { not: null },
          },
        })
      : [];
    let postVisitMessages = 0;
    if (provisionalGuests.length) {
      await this.klaviyo.sendCampaign(provisionalGuests.length, {
        template: 'post_visit_loyalty_claim',
        venue: venue?.name ?? venueId,
        message: `You earned credit at ${venue?.name ?? 'the venue'} — claim it in A-List.`,
        guestIds: provisionalGuests.map((g) => g.id),
      });
      postVisitMessages = provisionalGuests.length;
    }

    return {
      venueId,
      bookings: bookings.length,
      totalTab,
      takeRate,
      takeRateBps: bps,
      postVisitMessages,
      usageEventId: usage.id,
    };
  }
}

@ApiTags('ops:closeout')
@Controller('venues')
export class CloseoutController {
  constructor(private readonly svc: CloseoutService) {}

  @Post(':id/closeout')
  @Scopes('ops:closeout:write')
  closeout(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CloseoutDto,
  ) {
    return this.svc.closeout(ctx, id, dto);
  }
}

@Module({
  controllers: [CloseoutController],
  providers: [CloseoutService],
  exports: [CloseoutService],
})
export class CloseoutModule {}
