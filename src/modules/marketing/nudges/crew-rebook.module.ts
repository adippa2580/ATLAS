import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { KlaviyoAdapter } from '../../../integrations/klaviyo.adapter';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

/** Body for POST /v1/nudges/crew-rebook — lapse window is optional. */
class CrewRebookBodyDto {
  /** A crew qualifies if its most recent booking is older than this. */
  @IsOptional() @IsInt() @Min(1) @Max(365) sinceDays?: number;
}

/** Default lapse window (days) for a crew's most recent booking. */
const DEFAULT_SINCE_DAYS = 45;

/**
 * Booking statuses that count as a crew having actually shown up before. A
 * held/confirmed/cancelled booking is not evidence of a repeatable crew visit;
 * only a seated or closed one is.
 */
const PAST_VISIT_STATUSES = ['closed', 'seated'] as const;

/**
 * Crew re-booking nudges — leans on the group return-rate advantage. Finds
 * crews that have booked as a group before (a past seated/closed crew booking)
 * whose most recent crew booking has lapsed beyond `sinceDays` AND who have
 * nothing on the calendar going forward, then dispatches ONE re-book nudge per
 * crew to its members via Klaviyo. Idempotent per (crew, UTC day) through the
 * shared idempotency ledger, so a same-day retry never double-sends a crew.
 */
@Injectable()
export class CrewRebookService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly klaviyo: KlaviyoAdapter,
  ) {}

  /** UTC calendar day — the idempotency granularity for a nudge run. */
  private nudgeDay(now = new Date()): string {
    return now.toISOString().slice(0, 10); // YYYY-MM-DD
  }

  async nudgeLapsedCrews(ctx: TenantContext, dto: CrewRebookBodyDto) {
    const sinceDays = dto.sinceDays ?? DEFAULT_SINCE_DAYS;
    const now = new Date();
    const cutoff = new Date(now.getTime() - sinceDays * 86_400_000);

    // All crew-attributed bookings for the tenant. We derive both the "has a
    // qualifying past visit / most-recent past visit" signal and the "has a
    // future booking" exclusion from this single read.
    const bookings = await this.prisma.booking.findMany({
      where: { tenantId: ctx.tenantId, crewId: { not: null } },
      select: { crewId: true, status: true, date: true },
    });

    // Per crew: most recent qualifying (seated/closed) PAST booking date, and
    // whether the crew has any future (date >= now) booking of any status.
    const lastPastByCrew = new Map<string, Date>();
    const hasFutureByCrew = new Set<string>();
    for (const b of bookings) {
      const crewId = b.crewId as string;
      if (b.date >= now) {
        hasFutureByCrew.add(crewId);
        continue;
      }
      if (!(PAST_VISIT_STATUSES as readonly string[]).includes(b.status)) {
        continue;
      }
      const cur = lastPastByCrew.get(crewId);
      if (!cur || b.date > cur) lastPastByCrew.set(crewId, b.date);
    }

    // Lapsed crews: a qualifying past visit older than the cutoff AND nothing
    // upcoming.
    const lapsedCrewIds = [...lastPastByCrew.entries()]
      .filter(([crewId, last]) => last < cutoff && !hasFutureByCrew.has(crewId))
      .map(([crewId]) => crewId);

    if (!lapsedCrewIds.length) {
      return { tenantId: ctx.tenantId, crewsNudged: 0, sent: 0 };
    }

    // Members of the lapsed crews — the audience for each nudge.
    const members = await this.prisma.crewMember.findMany({
      where: { tenantId: ctx.tenantId, crewId: { in: lapsedCrewIds } },
      select: { crewId: true, guestId: true },
    });
    const membersByCrew = new Map<string, string[]>();
    for (const m of members) {
      const arr = membersByCrew.get(m.crewId) ?? [];
      arr.push(m.guestId);
      membersByCrew.set(m.crewId, arr);
    }

    // Contact keys for every crew member, resolved once, so the Klaviyo rail can
    // deliver to each member's own email/phone in live mode.
    const contactRows = await this.prisma.guest.findMany({
      where: {
        tenantId: ctx.tenantId,
        id: { in: [...new Set(members.map((m) => m.guestId))] },
      },
      select: { id: true, email: true, primaryPhone: true, displayName: true },
    });
    const contactByGuest = new Map(contactRows.map((g) => [g.id, g]));

    const nudgeDay = this.nudgeDay(now);
    let crewsNudged = 0;
    let sent = 0;
    for (const crewId of lapsedCrewIds) {
      const guestIds = membersByCrew.get(crewId) ?? [];
      if (!guestIds.length) continue; // no one to reach

      // Idempotent per (crew, day): the ledger's unique (tenantId, key) makes a
      // same-day retry a no-op, so a crew is never nudged twice in one day.
      const key = `crew-rebook:${crewId}:${nudgeDay}`;
      const already = await this.prisma.idempotencyRecord.findFirst({
        where: { tenantId: ctx.tenantId, key },
      });
      if (already) continue;

      const recipients = KlaviyoAdapter.toRecipients(
        guestIds
          .map((id) => contactByGuest.get(id))
          .filter((g): g is NonNullable<typeof g> => !!g),
        { crewId },
      );
      await this.klaviyo.sendCampaign(
        guestIds.length,
        {
          template: 'crew_rebook_nudge',
          crewId,
          guestIds,
          lastVisit: lastPastByCrew.get(crewId),
          sinceDays,
          message:
            "Get the crew back together — your table's waiting. Re-book your last spot in a tap.",
        },
        recipients,
      );

      await this.prisma.idempotencyRecord.create({
        data: {
          tenantId: ctx.tenantId,
          key,
          method: 'POST',
          path: '/v1/nudges/crew-rebook',
        },
      });
      crewsNudged += 1;
      sent += guestIds.length;
    }

    return { tenantId: ctx.tenantId, crewsNudged, sent };
  }
}

@ApiTags('mkt:nudges')
@Controller('nudges')
export class CrewRebookController {
  constructor(private readonly svc: CrewRebookService) {}

  /** Nudge lapsed-but-loyal crews with nothing upcoming to re-book. */
  @Post('crew-rebook')
  @Scopes('mkt:lifecycle:write')
  crewRebook(@Tenant() ctx: TenantContext, @Body() dto: CrewRebookBodyDto) {
    return this.svc.nudgeLapsedCrews(ctx, dto);
  }
}

@Module({
  controllers: [CrewRebookController],
  providers: [CrewRebookService],
  exports: [CrewRebookService],
})
export class CrewRebookModule {}
