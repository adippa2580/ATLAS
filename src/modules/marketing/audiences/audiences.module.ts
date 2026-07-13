import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsNumber, IsObject, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

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

@Injectable()
export class AudiencesService {
  constructor(private readonly prisma: PrismaService) {}

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
}

@Module({
  controllers: [AudiencesController],
  providers: [AudiencesService],
  exports: [AudiencesService],
})
export class AudiencesModule {}
