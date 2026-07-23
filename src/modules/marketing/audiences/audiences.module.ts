import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { KlaviyoAdapter } from '../../../integrations/klaviyo.adapter';
import { REACHABLE_CONSENT_SCOPES } from './taste-segments.module';

// Predicates over affinity / spend / recency (geo later).
class AudienceQueryDto {
  @IsOptional() @IsString() subjectRef?: string;
  @IsOptional() @IsNumber() minScore?: number;
  @IsOptional() @IsNumber() lapsedDays?: number;
  @IsOptional() @IsNumber() minSpend?: number;
}

class SaveAudienceDto {
  @IsString() name!: string;
  @IsObject() predicates!: Record<string, any>;
}

// Discovery send to a predicate-defined audience — consent-gated, never a blast.
class AudienceReachDto {
  @IsOptional() @IsString() subjectRef?: string;
  @IsOptional() @IsNumber() minScore?: number;
  @IsOptional() @IsString() name?: string;
}

@Injectable()
export class AudiencesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly klaviyo: KlaviyoAdapter,
  ) {}

  /**
   * Audience Studio: resolve predicates into a matching guest COUNT and an
   * ESTIMATED REVENUE ("123 guests love Afro House and haven't visited in 4
   * months… est. $146k"). Delivery is discovery, never a blast.
   */
  async query(ctx: TenantContext, dto: AudienceQueryDto) {
    // 1. Affinity predicate → candidate guest set.
    let guestIds: string[] | undefined;
    if (dto.subjectRef || dto.minScore != null) {
      const affinities = await this.prisma.guestAffinity.findMany({
        where: {
          tenantId: ctx.tenantId,
          muted: false,
          ...(dto.subjectRef ? { subjectRef: dto.subjectRef } : {}),
          ...(dto.minScore != null ? { score: { gte: dto.minScore } } : {}),
        },
        select: { guestId: true },
      });
      guestIds = [...new Set(affinities.map((a) => a.guestId))];
    }

    const guests = await this.prisma.guest.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(guestIds ? { id: { in: guestIds } } : {}),
      },
      select: { id: true },
    });
    let candidates = guests.map((g) => g.id);

    // 2. Recency predicate → drop guests who booked within the window (lapsed).
    if (dto.lapsedDays != null && candidates.length) {
      const cutoff = new Date(Date.now() - dto.lapsedDays * 86_400_000);
      const recent = await this.prisma.booking.findMany({
        where: {
          tenantId: ctx.tenantId,
          guestId: { in: candidates },
          date: { gte: cutoff },
        },
        select: { guestId: true },
      });
      const recentSet = new Set(recent.map((b) => b.guestId));
      candidates = candidates.filter((id) => !recentSet.has(id));
    }

    // 3. Spend predicate → keep guests whose historical tab spend clears minSpend.
    if (dto.minSpend != null && candidates.length) {
      const tabs = await this.prisma.tab.findMany({
        where: {
          tenantId: ctx.tenantId,
          booking: { guestId: { in: candidates } },
        },
        select: { total: true, booking: { select: { guestId: true } } },
      });
      const spendByGuest = new Map<string, number>();
      for (const t of tabs) {
        const gid = t.booking.guestId;
        spendByGuest.set(gid, (spendByGuest.get(gid) ?? 0) + t.total);
      }
      candidates = candidates.filter(
        (id) => (spendByGuest.get(id) ?? 0) >= dto.minSpend!,
      );
    }

    const count = candidates.length;

    // Estimated revenue = count * average historical tab spend for the tenant
    // (placeholder for the revenue model; falls back to a nominal value).
    const agg = await this.prisma.tab.aggregate({
      where: { tenantId: ctx.tenantId },
      _avg: { total: true },
    });
    const avgSpend = agg._avg.total ?? 150;
    const estimatedRevenue = Math.round(count * avgSpend);

    return { count, estimatedRevenue, predicates: dto };
  }

  save(ctx: TenantContext, dto: SaveAudienceDto) {
    return this.prisma.audience.create({
      data: {
        tenantId: ctx.tenantId,
        name: dto.name,
        predicates: dto.predicates as any,
      },
    });
  }

  /**
   * Reach a predicate-defined audience: resolve the matching guests **who have
   * granted a reachable consent** (marketing/identity, not revoked), persist the
   * audience, and hand them to the Klaviyo rail as a discovery send. Consent is a
   * hard dependency — an unconsented guest is never contacted — and the adapter
   * is stub-first, so with no key it logs the intent and delivers nothing.
   */
  async reach(ctx: TenantContext, dto: AudienceReachDto) {
    let guestIds: string[] | undefined;
    if (dto.subjectRef || dto.minScore != null) {
      const affinities = await this.prisma.guestAffinity.findMany({
        where: {
          tenantId: ctx.tenantId,
          muted: false,
          ...(dto.subjectRef ? { subjectRef: dto.subjectRef } : {}),
          ...(dto.minScore != null ? { score: { gte: dto.minScore } } : {}),
        },
        select: { guestId: true },
      });
      guestIds = [...new Set(affinities.map((a) => a.guestId))];
    }

    const guests = await this.prisma.guest.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(guestIds ? { id: { in: guestIds } } : {}),
        // The consent gate: only guests with a live reachable grant.
        consents: {
          some: { revokedAt: null, scope: { in: REACHABLE_CONSENT_SCOPES } },
        },
      },
      select: {
        id: true,
        email: true,
        primaryPhone: true,
        displayName: true,
      },
    });

    const audience = await this.prisma.audience.create({
      data: {
        tenantId: ctx.tenantId,
        name: dto.name || `Reach · ${dto.subjectRef ?? 'surfaced audience'}`,
        predicates: {
          subjectRef: dto.subjectRef ?? null,
          minScore: dto.minScore ?? null,
          reached: true,
        } as any,
      },
    });

    const delivery = await this.klaviyo.sendCampaign(
      guests.length,
      {
        template: 'lifecycle_campaign',
        audienceId: audience.id,
        subjectRef: dto.subjectRef ?? null,
      },
      KlaviyoAdapter.toRecipients(guests, { audienceId: audience.id }),
    );

    return { audienceId: audience.id, count: guests.length, delivery };
  }
}

@ApiTags('mkt:audiences')
@Controller()
export class AudiencesController {
  constructor(private readonly svc: AudiencesService) {}

  // Spec path is `POST /v1/audiences:query`; the `:` conflicts with Nest route
  // params, so it is mounted as `audiences/query`.
  @Post('audiences/query')
  @Scopes('mkt:audiences:read')
  query(@Tenant() ctx: TenantContext, @Body() dto: AudienceQueryDto) {
    return this.svc.query(ctx, dto);
  }

  @Post('audiences')
  @Scopes('mkt:audiences:write')
  save(@Tenant() ctx: TenantContext, @Body() dto: SaveAudienceDto) {
    return this.svc.save(ctx, dto);
  }

  @Post('audiences/reach')
  @Scopes('mkt:audiences:write')
  reach(@Tenant() ctx: TenantContext, @Body() dto: AudienceReachDto) {
    return this.svc.reach(ctx, dto);
  }
}

@Module({
  controllers: [AudiencesController],
  providers: [AudiencesService],
  exports: [AudiencesService],
})
export class AudiencesModule {}
