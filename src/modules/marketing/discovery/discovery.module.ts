import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class CrewRecsDto {
  @IsString() crewId!: string;
}

/**
 * Cold-start threshold: a guest with fewer than this many of their own
 * (non-muted) affinity rows is treated as "cold" — new/provisional, not enough
 * personal taste to rank on. Below it we seed from the blended crew affinity of
 * the crews they belong to rather than returning empty/thin results.
 */
export const COLDSTART_AFFINITY_THRESHOLD = 3;

export type RecommendationSource = 'personal' | 'crew-blend-coldstart';

@Injectable()
export class DiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "Spotify for nights out": ranked recommendations from the guest's resolved
   * affinity (mutes applied, decay-aware, score desc), joined to the shared
   * Entity catalog where a subjectRef resolves to a catalog id.
   *
   * Cold-start (W2 crew blend): a guest with too little personal taste of their
   * own (below COLDSTART_AFFINITY_THRESHOLD) falls back to the blended crew
   * affinity of the crews they belong to, so a brand-new guest still gets a warm
   * ranked list instead of an empty one. The response carries `source` so the
   * caller can see whether the picks are personal or crew-seeded.
   */
  async recommendations(ctx: TenantContext, guestId: string, context?: string) {
    const affinities = await this.prisma.guestAffinity.findMany({
      where: { tenantId: ctx.tenantId, guestId, muted: false },
      orderBy: { score: 'desc' },
      take: 50,
    });

    if (affinities.length < COLDSTART_AFFINITY_THRESHOLD) {
      const cold = await this.crewBlendColdStart(ctx, guestId, context);
      if (cold) return cold;
    }

    return {
      source: 'personal' as RecommendationSource,
      items: await this.withEntities(
        affinities.map((a) => ({
          subjectType: a.subjectType,
          subjectRef: a.subjectRef,
          score: a.score,
        })),
        context,
      ),
    };
  }

  /**
   * Seed a cold guest from the crews they belong to. Blends CrewAffinity across
   * every crew the guest is a member of (a guest can be in several), summing the
   * per-crew blendedScore per subject and keeping the strongest confidence, then
   * ranks score desc. Tenant-scoped throughout. Returns null when the guest is
   * in no crew (or the crews have no blend yet) so the caller keeps the personal
   * path — a cold guest with no crew has nothing to fall back to.
   */
  private async crewBlendColdStart(
    ctx: TenantContext,
    guestId: string,
    context?: string,
  ) {
    const memberships = await this.prisma.crewMember.findMany({
      where: { tenantId: ctx.tenantId, guestId },
      select: { crewId: true },
    });
    const crewIds = [...new Set(memberships.map((m) => m.crewId))];
    if (crewIds.length === 0) return null;

    const crewAffinities = await this.prisma.crewAffinity.findMany({
      where: { tenantId: ctx.tenantId, crewId: { in: crewIds } },
      orderBy: { blendedScore: 'desc' },
    });
    if (crewAffinities.length === 0) return null;

    // Blend across the guest's crews: one subject may surface in several crews.
    type Blend = {
      subjectType: (typeof crewAffinities)[number]['subjectType'];
      subjectRef: string;
      score: number;
      confidence: number;
    };
    const blended = new Map<string, Blend>();
    for (const c of crewAffinities) {
      const k = `${c.subjectType}:${c.subjectRef}`;
      const cur = blended.get(k);
      if (cur) {
        cur.score += c.blendedScore;
        cur.confidence = Math.max(cur.confidence, c.confidence);
      } else {
        blended.set(k, {
          subjectType: c.subjectType,
          subjectRef: c.subjectRef,
          score: c.blendedScore,
          confidence: c.confidence,
        });
      }
    }

    const ranked = Array.from(blended.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 50);

    return {
      source: 'crew-blend-coldstart' as RecommendationSource,
      items: await this.withEntities(
        ranked.map((r) => ({
          subjectType: r.subjectType,
          subjectRef: r.subjectRef,
          score: r.score,
          confidence: r.confidence,
        })),
        context,
      ),
    };
  }

  /** Join a ranked subject list to the shared Entity catalog by subjectRef. */
  private async withEntities<T extends { subjectRef: string }>(
    rows: T[],
    context?: string,
  ) {
    const refs = [...new Set(rows.map((r) => r.subjectRef))];
    const entities = refs.length
      ? await this.prisma.entity.findMany({ where: { id: { in: refs } } })
      : [];
    const byId = new Map(entities.map((e) => [e.id, e]));
    return rows.map((r) => ({
      ...r,
      entity: byId.get(r.subjectRef) ?? null,
      context: context ?? null,
    }));
  }

  /** Crew-blended recommendations from the learned crew affinity blend. */
  crewRecommendations(_ctx: TenantContext, crewId: string) {
    return this.prisma.crewAffinity.findMany({
      where: { crewId },
      orderBy: { blendedScore: 'desc' },
      take: 50,
    });
  }
}

@ApiTags('mkt:discovery')
@Controller()
export class DiscoveryController {
  constructor(private readonly svc: DiscoveryService) {}

  @Get('guests/:id/recommendations')
  @Scopes('mkt:discovery:read')
  recommendations(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('context') context?: string,
  ) {
    return this.svc.recommendations(ctx, id, context);
  }

  // Spec path is `POST /v1/recommendations:crew`; mounted as
  // `recommendations/crew` because `:` conflicts with Nest route params.
  @Post('recommendations/crew')
  @Scopes('mkt:discovery:read')
  crew(@Tenant() ctx: TenantContext, @Body() dto: CrewRecsDto) {
    return this.svc.crewRecommendations(ctx, dto.crewId);
  }
}

@Module({
  controllers: [DiscoveryController],
  providers: [DiscoveryService],
  exports: [DiscoveryService],
})
export class DiscoveryModule {}
