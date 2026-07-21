import {
  Body,
  ConflictException,
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
import {
  BookingStatus,
  Prisma,
  Provenance,
  Signal,
  SubjectType,
} from '@prisma/client';
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
   * Append-only status ledger (§4.1): record a single `held → confirmed →
   * seated → closed / cancelled` transition. Accepts a transaction client so
   * the ledger write lands in the SAME transaction as the status write it
   * mirrors; a plain PrismaService is assignable to `Prisma.TransactionClient`.
   */
  private recordStatusTransition(
    client: Prisma.TransactionClient,
    args: {
      tenantId: string;
      bookingId: string;
      fromStatus: BookingStatus | null;
      toStatus: BookingStatus;
    },
  ) {
    return client.bookingStatusEvent.create({
      data: {
        tenantId: args.tenantId,
        bookingId: args.bookingId,
        fromStatus: args.fromStatus,
        toStatus: args.toStatus,
      },
    });
  }

  /**
   * Hold → confirm in one call (`Idempotency-Key` accepted). Confirming
   * publishes `book` evidence (subject = the venue) and writes a metering event.
   */
  async create(
    ctx: TenantContext,
    dto: CreateBookingDto,
    idempotencyKey?: string,
    // Evidence provenance for the `book` signal. Venue-link (class 1b) checkouts
    // pass `venue_link` so pre-merge evidence stays single-venue (W1 §4.3).
    provenance: Provenance = Provenance.booking,
  ) {
    // P0-4 idempotency (fast path): if this key already produced a booking,
    // return it — never create a second booking or a second usage event.
    if (idempotencyKey) {
      const existing = await this.prisma.booking.findUnique({
        where: {
          tenantId_idempotencyKey: {
            tenantId: ctx.tenantId,
            idempotencyKey,
          },
        },
      });
      if (existing) return existing;
    }

    let created: Awaited<ReturnType<typeof this.prisma.booking.create>>;
    try {
      // P0-5 overbooking + P0-4 atomicity: hold → confirm in ONE interactive
      // transaction, guarded by a row lock on the inventory so concurrent
      // creates serialise on the capacity check.
      created = await this.prisma.$transaction(async (tx) => {
        if (dto.inventoryId) {
          // Lock the inventory row FOR UPDATE, scoped to this tenant.
          const locked = await tx.$queryRaw<
            { id: string; capacity: number }[]
          >`SELECT "id", "capacity" FROM "Inventory"
            WHERE "id" = ${dto.inventoryId} AND "tenantId" = ${ctx.tenantId}
            FOR UPDATE`;
          const inventory = locked[0];
          if (!inventory) throw new NotFoundException('Inventory not found');

          // Count non-cancelled bookings already on this table for the day.
          const range = AvailabilityService.dayRange(dto.date);
          const taken = await tx.booking.count({
            where: {
              tenantId: ctx.tenantId,
              inventoryId: dto.inventoryId,
              status: { not: 'cancelled' },
              ...(range ? { date: range } : { date: new Date(dto.date) }),
            },
          });
          if (taken >= inventory.capacity) {
            throw new ConflictException(
              'Inventory is fully booked for this date',
            );
          }
        }

        // Hold → confirm, collapsed into the transaction.
        const held = await tx.booking.create({
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
            idempotencyKey: idempotencyKey ?? null,
          },
        });
        // §4.1 ledger: creation is the `∅ → held` transition.
        await this.recordStatusTransition(tx, {
          tenantId: ctx.tenantId,
          bookingId: held.id,
          fromStatus: null,
          toStatus: BookingStatus.held,
        });
        const confirmed = await tx.booking.update({
          where: { id: held.id },
          data: { status: 'confirmed' },
        });
        // §4.1 ledger: the `held → confirmed` transition, same transaction.
        await this.recordStatusTransition(tx, {
          tenantId: ctx.tenantId,
          bookingId: held.id,
          fromStatus: BookingStatus.held,
          toStatus: BookingStatus.confirmed,
        });
        return confirmed;
      });
    } catch (err) {
      // A concurrent retry with the same key won the unique race — return the
      // existing booking rather than surfacing a 500 (and do NOT re-meter).
      if (
        idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        const existing = await this.prisma.booking.findUnique({
          where: {
            tenantId_idempotencyKey: {
              tenantId: ctx.tenantId,
              idempotencyKey,
            },
          },
        });
        if (existing) return existing;
      }
      throw err;
    }

    const booking = created;

    // Evidence + metering fire exactly once, only for a newly-created booking.
    // A confirmed booking is the strongest taste signal there is.
    await this.bus.publish({
      tenantId: ctx.tenantId,
      guestId: dto.guestId,
      subjectType: SubjectType.venue,
      subjectRef: dto.venueId,
      signal: Signal.book,
      weight: 3,
      provenance,
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
    const cancelled = await this.prisma.booking.update({
      where: { id },
      data: { status: 'cancelled' },
    });
    // §4.1 ledger: record the `<current> → cancelled` transition alongside the
    // status write (no surrounding transaction exists on this path).
    await this.recordStatusTransition(this.prisma, {
      tenantId: ctx.tenantId,
      bookingId: id,
      fromStatus: booking.status,
      toStatus: BookingStatus.cancelled,
    });
    return cancelled;
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
