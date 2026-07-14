import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { Provenance, Signal, SubjectType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvidenceBus } from '../../common/evidence/evidence-bus';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { evidenceDedupeKey } from '../../common/util/hash';
import { AvailabilityService } from './availability.service';

class CheckinDto {
  @IsString() bookingId!: string;
}

/**
 * Door List / Check-in (#15) — a capability inside Floor. Tonight's list plus
 * arrival marking; a check-in seats the booking and publishes an `attend`
 * signal (provenance `booking`).
 */
@Injectable()
export class DoorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  doorlist(ctx: TenantContext, venueId: string, date?: string) {
    const range = AvailabilityService.dayRange(date);
    return this.prisma.booking.findMany({
      where: {
        tenantId: ctx.tenantId,
        venueId,
        ...(range ? { date: range } : {}),
      },
      include: { guest: { include: { entitlements: true } }, inventory: true },
    });
  }

  async checkin(ctx: TenantContext, dto: CheckinDto) {
    const booking = await this.prisma.booking.findFirst({
      where: { id: dto.bookingId, tenantId: ctx.tenantId },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    const seated = await this.prisma.booking.update({
      where: { id: booking.id },
      data: { status: 'seated' },
    });

    await this.bus.publish({
      tenantId: ctx.tenantId,
      guestId: booking.guestId,
      subjectType: SubjectType.venue,
      subjectRef: booking.venueId,
      signal: Signal.attend,
      weight: 2,
      provenance: Provenance.booking,
      dedupeKey: evidenceDedupeKey('booking', booking.id, 'attend'),
      observedAt: new Date().toISOString(),
    });

    return seated;
  }
}

@ApiTags('ops:door')
@Controller('venues')
export class DoorlistController {
  constructor(private readonly svc: DoorService) {}

  @Get(':id/doorlist')
  @Scopes('ops:door:read')
  doorlist(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('date') date?: string,
  ) {
    return this.svc.doorlist(ctx, id, date);
  }
}

@ApiTags('ops:door')
@Controller('door')
export class DoorController {
  constructor(private readonly svc: DoorService) {}

  @Post('checkin')
  @Scopes('ops:door:write')
  checkin(@Tenant() ctx: TenantContext, @Body() dto: CheckinDto) {
    return this.svc.checkin(ctx, dto);
  }
}

@Module({
  controllers: [DoorlistController, DoorController],
  providers: [DoorService],
  exports: [DoorService],
})
export class DoorModule {}
