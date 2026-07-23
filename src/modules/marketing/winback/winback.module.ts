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
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { KlaviyoAdapter } from '../../../integrations/klaviyo.adapter';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

/** Body for POST /v1/winback/trigger — both fields optional, sensible defaults. */
class WinbackTriggerBodyDto {
  /** Lapse threshold in days (last visit older than this qualifies). */
  @IsOptional() @IsInt() @Min(1) @Max(365) days?: number;
  /** Cap the cohort to the top-N spenders. */
  @IsOptional() @IsInt() @Min(1) @Max(1000) limit?: number;
}

const DEFAULT_LAPSE_DAYS = 60;
/** Lifetime tab spend (integer cents) that qualifies a guest as a VIP. */
const DEFAULT_VIP_SPEND_CENTS = 50_000;

type TopAffinity = { subjectType: string; subjectRef: string; score: number };

@Injectable()
export class WinbackService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Relationship monitoring: guests who booked at the venue historically but
   * not recently (lapsed), each with a likely-cause stub (their top affinity).
   */
  async atRisk(
    ctx: TenantContext,
    venueId: string,
    lapsedDays = DEFAULT_LAPSE_DAYS,
  ) {
    const cutoff = new Date(Date.now() - lapsedDays * 86_400_000);

    const past = await this.prisma.booking.findMany({
      where: { tenantId: ctx.tenantId, venueId },
      select: { guestId: true, date: true },
    });

    // Last visit per guest.
    const lastByGuest = new Map<string, Date>();
    for (const b of past) {
      const cur = lastByGuest.get(b.guestId);
      if (!cur || b.date > cur) lastByGuest.set(b.guestId, b.date);
    }
    const lapsed = [...lastByGuest.entries()]
      .filter(([, d]) => d < cutoff)
      .map(([id]) => id);

    if (!lapsed.length) return [];

    // Top affinity per lapsed guest → likely cause.
    const topByGuest = await this.topAffinityByGuest(ctx, lapsed);

    return lapsed.map((id) => ({
      guestId: id,
      lastVisit: lastByGuest.get(id),
      likelyCause: topByGuest.get(id) ?? null,
    }));
  }

  /**
   * Sharpest affinity per guest (highest, non-muted). Shared taste-match
   * primitive: powers both the at-risk "likely cause" and the win-back send.
   */
  async topAffinityByGuest(
    ctx: TenantContext,
    guestIds: string[],
  ): Promise<Map<string, TopAffinity>> {
    const topByGuest = new Map<string, TopAffinity>();
    if (!guestIds.length) return topByGuest;

    const affinities = await this.prisma.guestAffinity.findMany({
      where: {
        tenantId: ctx.tenantId,
        guestId: { in: guestIds },
        muted: false,
      },
      orderBy: { score: 'desc' },
    });
    for (const a of affinities) {
      if (!topByGuest.has(a.guestId)) {
        topByGuest.set(a.guestId, {
          subjectType: a.subjectType,
          subjectRef: a.subjectRef,
          score: a.score,
        });
      }
    }
    return topByGuest;
  }
}

/**
 * Lapsed-VIP win-back (act-now recommendation). Computes the tenant's
 * top-spend guests who have lapsed beyond the threshold and dispatches one
 * taste-matched Klaviyo send per guest referencing their sharpest affinity.
 * Idempotent per (guest, campaign-day) via the shared idempotency ledger.
 */
@Injectable()
export class WinbackTriggerService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly klaviyo: KlaviyoAdapter,
    private readonly winback: WinbackService,
  ) {}

  /** UTC calendar day — the idempotency granularity for a campaign. */
  private campaignDay(now = new Date()): string {
    return now.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  async triggerLapsedVip(ctx: TenantContext, dto: WinbackTriggerBodyDto) {
    const lapseDays = dto.days ?? DEFAULT_LAPSE_DAYS;
    const cutoff = new Date(Date.now() - lapseDays * 86_400_000);

    // Tenant-wide booking history with tab spend (all money is integer cents).
    const bookings = await this.prisma.booking.findMany({
      where: { tenantId: ctx.tenantId },
      select: { guestId: true, date: true, tab: { select: { total: true } } },
    });

    // Per guest: last visit + lifetime tab spend.
    const lastByGuest = new Map<string, Date>();
    const spendByGuest = new Map<string, number>();
    for (const b of bookings) {
      const last = lastByGuest.get(b.guestId);
      if (!last || b.date > last) lastByGuest.set(b.guestId, b.date);
      spendByGuest.set(
        b.guestId,
        (spendByGuest.get(b.guestId) ?? 0) + (b.tab?.total ?? 0),
      );
    }

    // Lapsed VIPs: last visit beyond the lapse cutoff AND lifetime spend at or
    // above the VIP floor. Ordered top-spend first, then capped to `limit`.
    let cohort = [...lastByGuest.entries()]
      .filter(
        ([id, last]) =>
          last < cutoff &&
          (spendByGuest.get(id) ?? 0) >= DEFAULT_VIP_SPEND_CENTS,
      )
      .map(([id, last]) => ({
        guestId: id,
        lastVisit: last,
        spend: spendByGuest.get(id) ?? 0,
      }))
      .sort((a, b) => b.spend - a.spend);

    if (dto.limit) cohort = cohort.slice(0, dto.limit);

    const cohortSize = cohort.length;
    if (!cohortSize) {
      return { tenantId: ctx.tenantId, cohortSize: 0, sent: 0 };
    }

    // Taste-match: reuse the at-risk affinity primitive for each guest's
    // sharpest driver so the offer references what they actually care about.
    const topAffinity = await this.winback.topAffinityByGuest(
      ctx,
      cohort.map((c) => c.guestId),
    );

    // Contact keys for the cohort, resolved once — the Klaviyo rail delivers to
    // the guest's own email/phone in live mode.
    const contactRows = await this.prisma.guest.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: cohort.map((c) => c.guestId) },
      },
      select: { id: true, email: true, primaryPhone: true, displayName: true },
    });
    const contactByGuest = new Map(contactRows.map((g) => [g.id, g]));

    const campaignDay = this.campaignDay();
    let sent = 0;
    for (const c of cohort) {
      // Idempotent per (guest, campaign-day): the ledger's unique (tenantId,
      // key) makes a same-day retry a no-op, so a guest is never double-sent.
      const key = `winback:${c.guestId}:${campaignDay}`;
      const already = await this.prisma.idempotencyRecord.findFirst({
        where: { tenantId: ctx.tenantId, key },
      });
      if (already) continue;

      const affinity = topAffinity.get(c.guestId) ?? null;
      const contact = contactByGuest.get(c.guestId);
      await this.klaviyo.sendCampaign(
        1,
        {
          template: 'lapsed_vip_winback',
          guestIds: [c.guestId],
          lapseDays,
          topAffinity: affinity,
          message: affinity
            ? `We miss you — new ${affinity.subjectType} picks matched to your taste, and a table on us.`
            : `We miss you — your table's waiting whenever you're back.`,
        },
        contact ? KlaviyoAdapter.toRecipients([contact]) : [],
      );

      await this.prisma.idempotencyRecord.create({
        data: {
          tenantId: ctx.tenantId,
          key,
          method: 'POST',
          path: '/v1/winback/trigger',
        },
      });
      sent += 1;
    }

    return { tenantId: ctx.tenantId, cohortSize, sent };
  }
}

@ApiTags('mkt:winback')
@Controller()
export class WinbackController {
  constructor(
    private readonly svc: WinbackService,
    private readonly triggerSvc: WinbackTriggerService,
  ) {}

  @Get('venues/:id/at-risk')
  @Scopes('mkt:winback:read')
  atRisk(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.atRisk(ctx, id);
  }

  /** Arm the lapsed-VIP win-back: taste-matched offers to top-spend lapsers. */
  @Post('winback/trigger')
  @Scopes('mkt:lifecycle:write')
  trigger(@Tenant() ctx: TenantContext, @Body() dto: WinbackTriggerBodyDto) {
    return this.triggerSvc.triggerLapsedVip(ctx, dto);
  }
}

@Module({
  controllers: [WinbackController],
  providers: [WinbackService, WinbackTriggerService],
  exports: [WinbackService, WinbackTriggerService],
})
export class WinbackModule {}
