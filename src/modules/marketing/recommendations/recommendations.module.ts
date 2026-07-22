import { randomUUID } from 'crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { SubjectType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { KlaviyoAdapter } from '../../../integrations/klaviyo.adapter';
import {
  DEFAULT_DROP_COUNT,
  InventoryDropModule,
  InventoryDropService,
} from '../../ops/inventory-drop.module';

const DEFAULT_WINDOW_DAYS = 21;
const DEFAULT_MIN_SCORE = 1;
const REACHABLE_CONSENT_SCOPES = ['marketing', 'identity'];

class ActDto {
  @IsIn(['promote_matched', 'late_night_drop', 'mint_link', 'defend_regulars'])
  action!:
    'promote_matched' | 'late_night_drop' | 'mint_link' | 'defend_regulars';
  @IsOptional() @IsString() eventId?: string;
  @IsOptional() @IsString() venueId?: string;
  @IsOptional() @IsInt() @Min(0) minScore?: number;
}

export interface GroundedRecommendation {
  id: string;
  kind: 'event_demand' | 'late_night_fill' | 'competitor_opening';
  headline: string;
  date: string | null;
  /**
   * Regional relevance (2026-07-22 product rule): promotion is borderless —
   * venues market to travellers — but IMPACT is regional. 'local' = same city
   * as the venue; 'destination' = elsewhere; null = unknown.
   */
  relevance: 'local' | 'destination' | null;
  insight: string;
  matched: number;
  repeatMatched: number;
  actions: { action: string; label: string }[];
}

/**
 * Grounded recommendations — the "what do I do next" layer.
 *
 * Design rule (from the GM review, 2026-07-22): a recommendation must name the
 * entity, the date, and the audience it can reach, or it does not ship. "Festival
 * after-parties in demand ▲" is not intelligence; "Sundown Festival · Sat —
 * 34 consented matches (12 repeat guests) · promote / release late slots /
 * mint link" is. Every insight here is computed from the entity catalog + the
 * taste graph + consent state — nothing is narrated. Events without a date in
 * catalog metadata are EXCLUDED and reported in `ungrounded` rather than
 * hand-waved into a vibe.
 *
 * Each recommendation carries only actions the platform can actually execute:
 *   promote_matched  → Audience row + campaign via the Klaviyo rail
 *   late_night_drop  → InventoryDropService (after-party slots)
 *   mint_link        → AttributionLink with event-scoped campaign id
 */
@Injectable()
export class RecommendationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly klaviyo: KlaviyoAdapter,
    private readonly drops: InventoryDropService,
  ) {}

  private parseDate(
    metadata: unknown,
    key: 'date' | 'openingDate' = 'date',
  ): Date | null {
    const raw = (metadata as Record<string, string> | null)?.[key];
    if (!raw) return null;
    const d = new Date(raw);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  /** Consented repeat guests with a recent booking here — who a rival can poach. */
  private async exposedRegulars(ctx: TenantContext, venueId: string) {
    const since = new Date(Date.now() - 60 * 86_400_000);
    const recent = await this.prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        venueId,
        status: { not: 'cancelled' },
        date: { gte: since },
        guest: {
          provisional: false,
          consents: {
            some: { revokedAt: null, scope: { in: REACHABLE_CONSENT_SCOPES } },
          },
        },
      },
      select: { guestId: true },
    });
    return [...new Set(recent.map((b) => b.guestId))];
  }

  private genresOf(metadata: unknown): string[] {
    const g = (metadata as { genres?: unknown } | null)?.genres;
    return Array.isArray(g)
      ? g.filter((x): x is string => typeof x === 'string')
      : [];
  }

  /** Consented, non-provisional guests matching an event via the taste graph. */
  private async matchAudience(
    ctx: TenantContext,
    event: { id: string; name: string; metadata: unknown },
    venueId: string | undefined,
    minScore: number,
  ) {
    const genres = this.genresOf(event.metadata);
    const subjectFilters: {
      subjectType: SubjectType;
      subjectRef: { in: string[] };
    }[] = [
      {
        subjectType: SubjectType.event,
        subjectRef: { in: [event.id, event.name] },
      },
    ];
    if (genres.length) {
      subjectFilters.push({
        subjectType: SubjectType.genre,
        subjectRef: { in: genres },
      });
    }

    const affinities = await this.prisma.guestAffinity.findMany({
      where: {
        tenantId: ctx.tenantId,
        muted: false,
        score: { gte: minScore },
        OR: subjectFilters,
        guest: {
          provisional: false,
          consents: {
            some: { revokedAt: null, scope: { in: REACHABLE_CONSENT_SCOPES } },
          },
        },
      },
      select: { guestId: true },
    });
    const matchedIds = [...new Set(affinities.map((a) => a.guestId))];

    let repeatIds: string[] = [];
    if (matchedIds.length && venueId) {
      const repeats = await this.prisma.booking.findMany({
        where: {
          tenantId: ctx.tenantId,
          venueId,
          guestId: { in: matchedIds },
          status: { not: 'cancelled' },
        },
        select: { guestId: true },
      });
      repeatIds = [...new Set(repeats.map((b) => b.guestId))];
    }
    return { matchedIds, repeatIds, genres };
  }

  private async resolveVenue(ctx: TenantContext, venueId?: string) {
    const v = venueId
      ? await this.prisma.venue.findFirst({
          where: { id: venueId, tenantId: ctx.tenantId },
        })
      : await this.prisma.venue.findFirst({
          where: { tenantId: ctx.tenantId },
        });
    return v ? { id: v.id, city: v.city ?? null } : null;
  }

  private relevanceOf(
    eventCity: string | null | undefined,
    venueCity: string | null,
  ): 'local' | 'destination' | null {
    if (!eventCity || !venueCity) return null;
    return eventCity.trim().toLowerCase() === venueCity.trim().toLowerCase()
      ? 'local'
      : 'destination';
  }

  async list(
    ctx: TenantContext,
    opts: { venueId?: string; windowDays?: number; minScore?: number } = {},
  ) {
    const windowDays = opts.windowDays ?? DEFAULT_WINDOW_DAYS;
    const minScore = opts.minScore ?? DEFAULT_MIN_SCORE;
    const venue = await this.resolveVenue(ctx, opts.venueId);
    const venueId = venue?.id;
    const venueCity = venue?.city ?? null;
    const now = new Date();
    const horizon = new Date(now.getTime() + windowDays * 86_400_000);

    const events = await this.prisma.entity.findMany({
      where: { kind: 'event' },
    });

    const recommendations: GroundedRecommendation[] = [];
    const ungrounded: string[] = [];

    for (const ev of events) {
      const date = this.parseDate(ev.metadata);
      if (!date) {
        ungrounded.push(ev.name);
        continue;
      }
      if (date < now || date > horizon) continue;

      const { matchedIds, repeatIds, genres } = await this.matchAudience(
        ctx,
        ev,
        venueId,
        minScore,
      );
      const dayLabel = date.toISOString().slice(0, 10);
      const evCity = (ev.metadata as { city?: string } | null)?.city ?? null;
      recommendations.push({
        id: `event:${ev.id}`,
        kind: 'event_demand',
        headline: evCity
          ? `${ev.name} · ${evCity} · ${dayLabel}`
          : `${ev.name} · ${dayLabel}`,
        date: date.toISOString(),
        relevance: this.relevanceOf(evCity, venueCity),
        insight: matchedIds.length
          ? `${matchedIds.length} consented guests match via taste graph` +
            (genres.length ? ` (${genres.join(' / ')})` : '') +
            (repeatIds.length
              ? ` — ${repeatIds.length} are repeat guests here`
              : '')
          : 'In catalog and dated, but no consented taste matches yet — grow connector coverage first',
        matched: matchedIds.length,
        repeatMatched: repeatIds.length,
        actions: matchedIds.length
          ? [
              {
                action: 'promote_matched',
                label: `Promote to ${matchedIds.length} matched guests`,
              },
              { action: 'late_night_drop', label: 'Release after-party slots' },
              { action: 'mint_link', label: 'Mint attributed promo link' },
            ]
          : [{ action: 'mint_link', label: 'Mint attributed promo link' }],
      });
    }

    // Competitor openings — grounded ONLY when a catalog venue entity carries
    // metadata.competitor + a dated openingDate (class-3 feed; no source, no
    // signal). The exposed audience is our own consented recent regulars — the
    // people a rival's opening weekend can actually poach.
    const venues = await this.prisma.entity.findMany({
      where: { kind: 'venue' },
    });
    for (const rival of venues) {
      const meta = rival.metadata as { competitor?: boolean } | null;
      if (!meta?.competitor) continue;
      const opening = this.parseDate(rival.metadata, 'openingDate');
      if (!opening) {
        ungrounded.push(rival.name);
        continue;
      }
      if (opening < now || opening > horizon) continue;
      // Regional impact rule: a rival opening in another state/city does not
      // split this venue's weekend crowd — suppress the impact rec entirely
      // when both cities are known and differ. (Promotion recs stay
      // borderless; impact recs are local.)
      const rivalCity =
        (rival.metadata as { city?: string } | null)?.city ?? null;
      const rel = this.relevanceOf(rivalCity, venueCity);
      if (rel === 'destination') continue;
      const exposed = venueId ? await this.exposedRegulars(ctx, venueId) : [];
      const dayLabel = opening.toISOString().slice(0, 10);
      recommendations.push({
        id: `competitor:${rival.id}`,
        kind: 'competitor_opening',
        headline: rivalCity
          ? `${rival.name} opens · ${rivalCity} · ${dayLabel}`
          : `${rival.name} opens · ${dayLabel}`,
        date: opening.toISOString(),
        relevance: rel,
        insight: exposed.length
          ? `Splits the weekend crowd — ${exposed.length} consented regulars booked here in the last 60 days are the exposed audience`
          : 'Splits the weekend crowd — no recent consented regulars to defend yet',
        matched: exposed.length,
        repeatMatched: exposed.length,
        actions: exposed.length
          ? [
              {
                action: 'defend_regulars',
                label: `Lock in ${exposed.length} regulars for that weekend`,
              },
              { action: 'late_night_drop', label: 'Release after-party slots' },
            ]
          : [{ action: 'late_night_drop', label: 'Release after-party slots' }],
      });
    }

    // Late-night fill: only when no live late-drop inventory exists yet.
    if (venueId) {
      const drops = await this.prisma.inventory.count({
        where: {
          tenantId: ctx.tenantId,
          venueId,
          label: { startsWith: 'Late Drop' },
        },
      });
      if (drops === 0) {
        recommendations.push({
          id: `latenight:${venueId}`,
          kind: 'late_night_fill',
          headline: 'Late-night fill opportunity',
          date: null,
          relevance: 'local',
          insight: `No after-party inventory released — ${DEFAULT_DROP_COUNT} late slots available to drop at standard minimums`,
          matched: 0,
          repeatMatched: 0,
          actions: [
            { action: 'late_night_drop', label: 'Release late-night slots' },
          ],
        });
      }
    }

    // Local first (impact + hometown demand), then by audience size. Destination
    // events stay listed — they are promotion opportunities, not noise.
    const rank = (r: GroundedRecommendation) =>
      r.relevance === 'local' ? 0 : 1;
    recommendations.sort((a, b) => rank(a) - rank(b) || b.matched - a.matched);
    return {
      tenantId: ctx.tenantId,
      venueId: venueId ?? null,
      windowDays,
      minScore,
      recommendations,
      // Truthfulness over completeness: dated grounding is required to ship a
      // recommendation; these catalog events need a date before they can act.
      ungrounded,
    };
  }

  async act(ctx: TenantContext, dto: ActDto) {
    const venue = await this.resolveVenue(ctx, dto.venueId);
    const venueId = venue?.id;
    if (!venueId) throw new BadRequestException('No venue for tenant');

    const event = dto.eventId
      ? await this.prisma.entity.findUnique({ where: { id: dto.eventId } })
      : null;
    if (dto.eventId && !event) throw new NotFoundException('Event not found');

    if (dto.action === 'late_night_drop') {
      const result = await this.drops.lateNightDrop(ctx, {
        venueId,
        label: event ? `Late Drop · ${event.name}` : undefined,
      });
      return { action: dto.action, ...result };
    }

    if (dto.action === 'mint_link') {
      const code = randomUUID().replace(/-/g, '').slice(0, 12);
      const link = await this.prisma.attributionLink.create({
        data: {
          tenantId: ctx.tenantId,
          venueId,
          campaignId: event ? `event:${event.id}` : 'recommendation',
          code,
        },
      });
      return {
        action: dto.action,
        code: link.code,
        campaignId: link.campaignId,
      };
    }

    if (dto.action === 'defend_regulars') {
      const exposed = await this.exposedRegulars(ctx, venueId);
      if (!exposed.length) {
        throw new BadRequestException('No consented regulars to defend');
      }
      const audience = await this.prisma.audience.create({
        data: {
          tenantId: ctx.tenantId,
          name: `Regulars lock-in · ${event?.name ?? 'defensive'}`,
          predicates: {
            defensive: true,
            rivalEventId: dto.eventId ?? null,
            matchedGuestIds: exposed,
          },
        },
      });
      const delivery = await this.klaviyo.sendCampaign(exposed.length, {
        template: 'regulars_lock_in',
        rival: event?.name ?? null,
        audienceId: audience.id,
      });
      return {
        action: dto.action,
        audienceId: audience.id,
        matched: exposed.length,
        delivery,
      };
    }

    // promote_matched
    if (!event) {
      throw new BadRequestException('promote_matched requires eventId');
    }
    const { matchedIds, repeatIds } = await this.matchAudience(
      ctx,
      event,
      venueId,
      dto.minScore ?? DEFAULT_MIN_SCORE,
    );
    if (!matchedIds.length) {
      throw new BadRequestException(
        'No consented matched guests to promote to',
      );
    }
    const audience = await this.prisma.audience.create({
      data: {
        tenantId: ctx.tenantId,
        name: `Matched · ${event.name}`,
        predicates: {
          eventId: event.id,
          minScore: dto.minScore ?? DEFAULT_MIN_SCORE,
          matchedGuestIds: matchedIds,
        },
      },
    });
    const delivery = await this.klaviyo.sendCampaign(matchedIds.length, {
      template: 'event_promo',
      event: event.name,
      date: this.parseDate(event.metadata)?.toISOString() ?? null,
      audienceId: audience.id,
    });
    return {
      action: dto.action,
      audienceId: audience.id,
      matched: matchedIds.length,
      repeatMatched: repeatIds.length,
      delivery,
    };
  }
}

@ApiTags('marketing:recommendations')
@Controller('recommendations')
export class RecommendationsController {
  constructor(private readonly service: RecommendationsService) {}

  @Get()
  @Scopes('mkt:reporting:read')
  list(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId?: string,
    @Query('windowDays') windowDays?: string,
    @Query('minScore') minScore?: string,
  ) {
    return this.service.list(ctx, {
      venueId,
      windowDays: windowDays ? parseInt(windowDays, 10) : undefined,
      minScore: minScore ? parseInt(minScore, 10) : undefined,
    });
  }

  @Post('act')
  @Scopes('mkt:reporting:write')
  act(@Tenant() ctx: TenantContext, @Body() dto: ActDto) {
    return this.service.act(ctx, dto);
  }
}

@Module({
  imports: [InventoryDropModule],
  providers: [RecommendationsService],
  controllers: [RecommendationsController],
  exports: [RecommendationsService],
})
export class RecommendationsModule {}
