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
import {
  riskScore,
  NoShowFeatures,
} from '../../insights/ops/ops-insights.module';

class CreateBookingDto {
  @IsString() venueId!: string;
  @IsString() guestId!: string;
  @IsOptional() @IsString() crewId?: string;
  @IsOptional() @IsString() inventoryId?: string;
  @IsString() date!: string;
  @IsOptional() @IsInt() partySize?: number;
  @IsOptional() @IsString() attributionId?: string;
  /** Venue campaign carried by the attribution link (W7 metering dimension). */
  @IsOptional() @IsString() campaignId?: string;
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

    // Metering: booking emits a usage_event for take-rate billing, carrying
    // the W7 dimensions (path + campaign + booking). billableAmount stays 0 at
    // creation — the take-rate is levied on seated bookings at closeout.
    await this.prisma.usageEvent.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'booking',
        billableAmount: 0,
        path: provenance === Provenance.venue_link ? 'venue_link' : 'app',
        campaignId: dto.campaignId,
        bookingId: booking.id,
      },
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

  /**
   * Instant-confirm coverage extension: auto-confirm a HELD booking WITHOUT a
   * deposit gate when the guest is "known and low-risk" — identity-matched
   * (`Guest.provisional === false`) AND low no-show risk (reusing the exported
   * `riskScore` model, Insight D). Policy: confirm iff `!provisional &&
   * riskScore < 35`. The `held → confirmed` status write lands in the SAME
   * transaction as its §4.1 ledger row, exactly mirroring the `create` confirm
   * path (which then publishes `book` evidence + meters a `usage_event`).
   *
   * Idempotent: re-running on an already-confirmed (or later) booking is a safe
   * no-op — it neither re-transitions nor re-publishes/re-meters.
   */
  async autoConfirm(ctx: TenantContext, id: string) {
    const booking = await this.prisma.booking.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: {
        guest: { select: { provisional: true } },
        inventory: { select: { deposit: true } },
      },
    });
    if (!booking) throw new NotFoundException('Booking not found');

    // Idempotent no-op: only a HELD booking is a candidate. An already-confirmed
    // (or seated/closed) booking returns `confirmed:true` without re-metering; a
    // cancelled booking is not eligible.
    if (booking.status !== BookingStatus.held) {
      if (booking.status === BookingStatus.cancelled) {
        return {
          confirmed: false as const,
          riskScore: null,
          reason: 'booking is cancelled',
        };
      }
      return { confirmed: true as const, riskScore: null, booking };
    }

    // Grounded no-show features (Insight D): trustNet where a `no_show` erodes
    // and every other TrustEvent builds; priorCancelled from this guest's
    // cancelled bookings; leadTimeHours from `date - createdAt`; hasDeposit from
    // the booked inventory; partySize + provisional from the booking/guest.
    const [trustEvents, priorCancelled] = await Promise.all([
      this.prisma.trustEvent.findMany({
        where: { tenantId: ctx.tenantId, guestId: booking.guestId },
        select: { kind: true, weight: true },
      }),
      this.prisma.booking.count({
        where: {
          tenantId: ctx.tenantId,
          guestId: booking.guestId,
          status: 'cancelled',
        },
      }),
    ]);
    const trustNet = trustEvents.reduce(
      (sum, ev) =>
        sum +
        (ev.kind === 'no_show' ? -Math.abs(ev.weight) : Math.abs(ev.weight)),
      0,
    );
    const provisional = booking.guest?.provisional ?? true;
    const features: NoShowFeatures = {
      trustNet,
      priorCancelled,
      leadTimeHours:
        (booking.date.getTime() - booking.createdAt.getTime()) /
        (60 * 60 * 1000),
      hasDeposit: (booking.inventory?.deposit ?? 0) > 0,
      partySize: booking.partySize,
      provisional,
    };
    const score = riskScore(features);

    // Gate: known (identity-matched) AND low-risk. Not eligible → DO NOT confirm.
    if (provisional || score >= 35) {
      return {
        confirmed: false as const,
        riskScore: score,
        reason: provisional
          ? 'guest identity is provisional'
          : 'no-show risk too high',
      };
    }

    // Eligible: `held → confirmed` + its §4.1 ledger row in ONE transaction,
    // mirroring the `create` confirm path.
    const confirmed = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.booking.update({
        where: { id: booking.id },
        data: { status: 'confirmed' },
      });
      await this.recordStatusTransition(tx, {
        tenantId: ctx.tenantId,
        bookingId: booking.id,
        fromStatus: BookingStatus.held,
        toStatus: BookingStatus.confirmed,
      });
      return updated;
    });

    // Evidence + metering fire exactly once on confirm — a confirmed booking is
    // the strongest taste signal there is. dedupeKey mirrors the create path
    // (`booking:<id>:book`) so a duplicate is harmless.
    await this.bus.publish({
      tenantId: ctx.tenantId,
      guestId: booking.guestId,
      subjectType: SubjectType.venue,
      subjectRef: booking.venueId,
      signal: Signal.book,
      weight: 3,
      provenance: Provenance.booking,
      dedupeKey: evidenceDedupeKey('booking', booking.id, 'book'),
      observedAt: new Date().toISOString(),
    });
    await this.prisma.usageEvent.create({
      data: {
        tenantId: ctx.tenantId,
        kind: 'booking',
        billableAmount: 0,
        path: 'app',
        bookingId: booking.id,
      },
    });

    return { confirmed: true as const, riskScore: score, booking: confirmed };
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

  /**
   * Extend instant-confirm coverage — auto-confirm a HELD booking for a known,
   * low-risk guest (identity-matched + no-show `riskScore < 35`). Not eligible
   * returns `{ confirmed:false, riskScore, reason }`; idempotent no-op otherwise.
   */
  @Post(':id/auto-confirm')
  @Scopes('ops:bookings:write')
  autoConfirm(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.autoConfirm(ctx, id);
  }
}

@Module({
  controllers: [AvailabilityController, BookingsController],
  providers: [BookingsService, AvailabilityService],
  exports: [BookingsService, AvailabilityService],
})
export class BookingsModule {}
