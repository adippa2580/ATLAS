import {
  BadRequestException,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubjectType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

const SUPPORTED_METRICS = ['repeat_rate', 'avg_spend', 'guest_growth'];

@Injectable()
export class ReportingService {
  constructor(private readonly prisma: PrismaService) {}

  private rangeDays(range?: string): number {
    if (!range) return 30;
    const m = /^(\d+)\s*d?$/.exec(range.trim());
    return m ? Number(m[1]) : 30;
  }

  /** Benchmarks computed from OLTP aggregates (OLAP-served in production). */
  async report(
    ctx: TenantContext,
    metric: string,
    venue?: string,
    range?: string,
  ) {
    const days = this.rangeDays(range);
    const cutoff = new Date(Date.now() - days * 86_400_000);
    let value: number;

    switch (metric) {
      case 'repeat_rate': {
        const bookings = await this.prisma.booking.findMany({
          where: {
            tenantId: ctx.tenantId,
            ...(venue ? { venueId: venue } : {}),
          },
          select: { guestId: true },
        });
        const counts = new Map<string, number>();
        for (const b of bookings) {
          counts.set(b.guestId, (counts.get(b.guestId) ?? 0) + 1);
        }
        const repeat = [...counts.values()].filter((c) => c > 1).length;
        value = counts.size ? repeat / counts.size : 0;
        break;
      }
      case 'avg_spend': {
        const agg = await this.prisma.tab.aggregate({
          where: {
            tenantId: ctx.tenantId,
            ...(venue ? { booking: { venueId: venue } } : {}),
          },
          _avg: { total: true },
        });
        value = agg._avg.total ?? 0;
        break;
      }
      case 'guest_growth': {
        value = await this.prisma.guest.count({
          where: { tenantId: ctx.tenantId, createdAt: { gte: cutoff } },
        });
        break;
      }
      default:
        throw new BadRequestException(
          `Unsupported metric '${metric}'. Supported: ${SUPPORTED_METRICS.join(', ')}`,
        );
    }

    return { metric, value, venue: venue ?? null, range: range ?? `${days}d` };
  }

  /** Community / cohort segmentation grouped by each guest's top genre affinity. */
  async cohort(ctx: TenantContext) {
    const affinities = await this.prisma.guestAffinity.findMany({
      where: {
        tenantId: ctx.tenantId,
        subjectType: SubjectType.genre,
        muted: false,
      },
      orderBy: { score: 'desc' },
    });

    const topByGuest = new Map<string, string>();
    for (const a of affinities) {
      if (!topByGuest.has(a.guestId)) topByGuest.set(a.guestId, a.subjectRef);
    }

    const cohorts = new Map<string, number>();
    for (const genre of topByGuest.values()) {
      cohorts.set(genre, (cohorts.get(genre) ?? 0) + 1);
    }

    return {
      groupedBy: 'top_genre_affinity',
      cohorts: [...cohorts.entries()].map(([genre, count]) => ({
        genre,
        count,
      })),
    };
  }
}

@ApiTags('mkt:reporting')
@Controller()
export class ReportingController {
  constructor(private readonly svc: ReportingService) {}

  @Get('reports/:metric')
  @Scopes('mkt:reporting:read')
  report(
    @Tenant() ctx: TenantContext,
    @Param('metric') metric: string,
    @Query('venue') venue?: string,
    @Query('range') range?: string,
  ) {
    return this.svc.report(ctx, metric, venue, range);
  }

  // Spec path is `POST /v1/reports:cohort`; mounted as `reports/cohort`.
  @Post('reports/cohort')
  @Scopes('mkt:reporting:read')
  cohort(@Tenant() ctx: TenantContext) {
    return this.svc.cohort(ctx);
  }
}

@Module({
  controllers: [ReportingController],
  providers: [ReportingService],
  exports: [ReportingService],
})
export class ReportingModule {}
