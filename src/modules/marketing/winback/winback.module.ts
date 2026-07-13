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
import { IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class WinbackTriggerDto {
  @IsString() venueId!: string;
  @IsString() signal!: string;
}

const DEFAULT_LAPSE_DAYS = 60;

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
    const affinities = await this.prisma.guestAffinity.findMany({
      where: { tenantId: ctx.tenantId, guestId: { in: lapsed }, muted: false },
      orderBy: { score: 'desc' },
    });
    const topByGuest = new Map<
      string,
      { subjectType: string; subjectRef: string; score: number }
    >();
    for (const a of affinities) {
      if (!topByGuest.has(a.guestId)) {
        topByGuest.set(a.guestId, {
          subjectType: a.subjectType,
          subjectRef: a.subjectRef,
          score: a.score,
        });
      }
    }

    return lapsed.map((id) => ({
      guestId: id,
      lastVisit: lastByGuest.get(id),
      likelyCause: topByGuest.get(id) ?? null,
    }));
  }

  /** Arm a winback on a signal (e.g. favourite artist announced) → queued campaign. */
  trigger(ctx: TenantContext, _dto: WinbackTriggerDto) {
    return this.prisma.campaign.create({
      data: {
        tenantId: ctx.tenantId,
        channel: 'winback',
        status: 'queued',
      },
    });
  }
}

@ApiTags('mkt:winback')
@Controller()
export class WinbackController {
  constructor(private readonly svc: WinbackService) {}

  @Get('venues/:id/at-risk')
  @Scopes('mkt:winback:read')
  atRisk(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.atRisk(ctx, id);
  }

  @Post('winback/trigger')
  @Scopes('mkt:winback:write')
  trigger(@Tenant() ctx: TenantContext, @Body() dto: WinbackTriggerDto) {
    return this.svc.trigger(ctx, dto);
  }
}

@Module({
  controllers: [WinbackController],
  providers: [WinbackService],
  exports: [WinbackService],
})
export class WinbackModule {}
