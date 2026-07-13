import {
  Body,
  Controller,
  Get,
  Headers,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvidenceBus } from '../../common/evidence/evidence-bus';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { evidenceDedupeKey } from '../../common/util/hash';
import { Provenance, Signal, SubjectType } from '@prisma/client';
import { AvailabilityService } from './availability.service';

class CreateBookingDto {
  @IsString() venueId!: string;
  @IsString() guestId!: string;
  @IsOptional() @IsString() crewId?: string;
  @IsOptional() @IsString() inventoryId?: string;
  @IsString() date!: string;
  @IsOptional() @IsInt() partySize?: number;
  @IsOptional() @IsString() attributionId?: string;
}

/**
 * Bookings (#9) — the `held → confirmed → seated → closed / cancelled` state
 * machine. A booking is a paid action and weighs most in the taste graph, so
 * confirming one publishes a `book` signal and meters a `usage_event`.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  /**
   * Hold → confirm in one call (`Idempotency-Key` accepted). Confirming
   * publishes `book` evidence (subject = the venue) and writes a metering event.
   */
  async create(
    ctx: TenantContext,
    dto: CreateBookingDto,
    idempotencyKey?: string,
  ) {
    // Create the hold first, then confirm — the state machine, collapsed.
    const held = await this.prisma.booking.create({
      data: {
        tenantId: ctx.tenantId,
        venueId: dto.venueId,
        guestId: dto.guestId,
        crewId: dto.crewId,
        inventoryId: dto.inventoryId,
        status: 'held',
        date: new Date(dto.date),
        partySize: dto.partySize ?? 1,
        attributionId: dto.attributionId,
      },
    });

    const booking = await this.prisma.booking.update({
      where: { id: held.id },
      data: { status: 'confirmed' },
    });

    // A confirmed booking is the strongest taste signal there is.
    await this.bus.publish({
      tenantId: ctx.tenantId,
      guestId: dto.guestId,
      subjectType: SubjectType.venue,
      subjectRef: dto.venueId,
      signal: Signal.book,
      weight: 3,
      provenance: Provenance.booking,
      dedupeKey: evidenceDedupeKey(
        'booking',
        idempotencyKey ?? booking.id,
        'book',
      ),
      observedAt: new Date().toISOString(),
    });

    // Metering: booking emits a usage_event for take-rate billing.
    await this.prisma.usageEvent.create({
      data: { tenantId: ctx.tenantId, kind: 'booking', billableAmount: 0 },
    });

    return booking;
  }

  async cancel(ctx: TenantContext, id: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (!booking) throw new NotFoundException('Booking not found');
    return this.prisma.booking.update({
      where: { id },
      data: { status: 'cancelled' },
    });
  }
}

@ApiTags('ops:bookings')
@Controller('venues')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get(':id/availability')
  @Scopes('ops:bookings:read')
  list(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Query('date') _date?: string,
    @Query('party') party?: string,
    @Query('crew') crew?: string,
  ) {
    return this.availability.rank(ctx, id, {
      party: party ? Number(party) : undefined,
      crewId: crew,
    });
  }
}

@ApiTags('ops:bookings')
@Controller('bookings')
export class BookingsController {
  constructor(private readonly svc: BookingsService) {}

  @Post()
  @Scopes('ops:bookings:write')
  create(
    @Tenant() ctx: TenantContext,
    @Body() dto: CreateBookingDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.svc.create(ctx, dto, idempotencyKey);
  }

  @Post(':id/cancel')
  @Scopes('ops:bookings:write')
  cancel(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.cancel(ctx, id);
  }
}

@Module({
  controllers: [AvailabilityController, BookingsController],
  providers: [BookingsService, AvailabilityService],
  exports: [BookingsService, AvailabilityService],
})
export class BookingsModule {}
