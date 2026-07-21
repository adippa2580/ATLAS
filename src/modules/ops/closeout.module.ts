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
      include: { tab: true, inventory: true },
    });

    // All money is integer minor units (cents).
    // W7 model (ADOPTED 2026-07-21, PLACEHOLDER rates pending Jack): per-seated-
    // booking take — tableBps on the table minimum (tab total when no minimum),
    // ticketBps on ticket revenue — metered as one usage_event PER BOOKING with
    // path/campaign dimensions. Setting both bps to 0 falls back to the legacy
    // aggregate closeout rate on total tab.
    const tableBps = this.config.get<number>('takeRateBps.table') ?? 1000;
    const ticketBps = this.config.get<number>('takeRateBps.ticket') ?? 800;
    const closeoutBps = this.config.get<number>('takeRateBps.closeout') ?? 500;
    const totalTab = bookings.reduce((sum, b) => sum + (b.tab?.total ?? 0), 0);

    // Campaign attribution for the metering dimensions.
    const attributionIds = [
      ...new Set(bookings.map((b) => b.attributionId).filter(Boolean)),
    ] as string[];
    const links = attributionIds.length
      ? await this.prisma.attributionLink.findMany({
          where: { id: { in: attributionIds } },
        })
      : [];
    const campaignByAttr = new Map(links.map((l) => [l.id, l.campaignId]));

    let takeRate = 0;
    let usage: { id: string } | null = null;
    const perBooking = tableBps > 0 || ticketBps > 0;
    if (perBooking) {
      for (const b of bookings) {
        if (b.status === 'cancelled') continue;
        const kind = b.inventory?.kind;
        const base =
          kind === 'table'
            ? (b.inventory?.minSpend ?? b.tab?.total ?? 0)
            : kind === 'ticket'
              ? (b.tab?.total ?? 0)
              : 0;
        const bps = kind === 'table' ? tableBps : kind === 'ticket' ? ticketBps : 0;
        const take = Math.round((base * bps) / 10_000);
        takeRate += take;
        usage = await this.prisma.usageEvent.create({
          data: {
            tenantId: ctx.tenantId,
            kind: 'booking',
            billableAmount: take,
            path: b.attributionId ? 'venue_link' : 'app',
            campaignId: b.attributionId
              ? (campaignByAttr.get(b.attributionId) ?? null)
              : null,
            bookingId: b.id,
          },
        });
      }
    } else {
      takeRate = Math.round((totalTab * closeoutBps) / 10_000);
      usage = await this.prisma.usageEvent.create({
        data: {
          tenantId: ctx.tenantId,
          kind: 'booking',
          billableAmount: takeRate,
        },
      });
    }

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
      takeRateModel: perBooking ? 'per_booking' : 'closeout_tab',
      takeRateBps: perBooking
        ? { table: tableBps, ticket: ticketBps }
        : { closeout: closeoutBps },
      postVisitMessages,
      usageEventId: usage?.id ?? null,
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
