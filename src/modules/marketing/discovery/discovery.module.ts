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

@Injectable()
export class DiscoveryService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * "Spotify for nights out": ranked recommendations from the guest's resolved
   * affinity (mutes applied, decay-aware, score desc), joined to the shared
   * Entity catalog where a subjectRef resolves to a catalog id.
   */
  async recommendations(ctx: TenantContext, guestId: string, context?: string) {
    const affinities = await this.prisma.guestAffinity.findMany({
      where: { tenantId: ctx.tenantId, guestId, muted: false },
      orderBy: { score: 'desc' },
      take: 50,
    });
    const refs = [...new Set(affinities.map((a) => a.subjectRef))];
    const entities = refs.length
      ? await this.prisma.entity.findMany({ where: { id: { in: refs } } })
      : [];
    const byId = new Map(entities.map((e) => [e.id, e]));

    return affinities.map((a) => ({
      subjectType: a.subjectType,
      subjectRef: a.subjectRef,
      score: a.score,
      entity: byId.get(a.subjectRef) ?? null,
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
