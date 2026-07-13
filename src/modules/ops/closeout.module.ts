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
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { AvailabilityService } from './availability.service';

class CloseoutDto {
  @IsOptional() @IsString() date?: string;
}

const TAKE_RATE = 0.05;

/**
 * Closeout / Settlement (#16) — nightly reconciliation. Sums the night's
 * bookings and tabs, then meters a `usage_event` whose billableAmount is the
 * take-rate (5% placeholder) of total tab spend.
 */
@Injectable()
export class CloseoutService {
  constructor(private readonly prisma: PrismaService) {}

  async closeout(ctx: TenantContext, venueId: string, dto: CloseoutDto) {
    const range = AvailabilityService.dayRange(dto.date);

    const bookings = await this.prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        venueId,
        ...(range ? { date: range } : {}),
      },
      include: { tab: true },
    });

    const totalTab = bookings.reduce((sum, b) => sum + (b.tab?.total ?? 0), 0);
    const takeRate = totalTab * TAKE_RATE;

    const usage = await this.prisma.usageEvent.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'booking',
        billableAmount: takeRate,
      },
    });

    return {
      venueId,
      bookings: bookings.length,
      totalTab,
      takeRate,
      usageEventId: usage.id,
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
