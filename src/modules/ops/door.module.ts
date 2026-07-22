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
import { IsBoolean, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { randomUUID } from 'crypto';
import {
  ConsentBasis,
  IdentityLinkKind,
  Provenance,
  Signal,
  SubjectType,
} from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvidenceBus } from '../../common/evidence/evidence-bus';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { evidenceDedupeKey, sha256 } from '../../common/util/hash';
import { IdentityService } from '../guest/identity/identity.service';
import { IdentityModule } from '../guest/identity/identity.module';
import { AvailabilityService } from './availability.service';

class CheckinDto {
  @IsString() bookingId!: string;
}

/**
 * A guest arriving at the door with no prior booking. Instrumenting this is the
 * top identity-pillar lever — un-enriched walk-ins are the largest negative
 * driver of identity coverage, because the check-in path only handles bookings
 * that already exist. Capturing a name/phone/email (or a scanned wallet pass)
 * plus an opt-in turns an anonymous arrival into a consented, enriched guest.
 */
class WalkInDto {
  @IsString() venueId!: string;

  @IsOptional() @IsInt() @Min(1) partySize?: number;

  @IsOptional() @IsString() displayName?: string;

  /** E.164 phone captured at the door. */
  @IsOptional() @IsString() phone?: string;

  @IsOptional() @IsString() email?: string;

  /** Table/booth the party is being seated at, if known. */
  @IsOptional() @IsString() inventoryId?: string;

  /** Set when the guest scanned an A-List wallet pass at the door. */
  @IsOptional() @IsString() walletPassId?: string;

  /** The guest opted in at the door — the consent that gates enrichment. */
  @IsOptional() @IsBoolean() consent?: boolean;

  /** Optional dedupe key so a double-scan doesn't create two walk-ins. */
  @IsOptional() @IsString() idempotencyKey?: string;
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
    private readonly identity: IdentityService,
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

  /**
   * Capture a walk-in with no prior booking: resolve or create the guest, seat
   * them as a booking, and — when they opt in — record consent + verified
   * identity links so they stop counting as an un-enriched arrival. Idempotent
   * on `idempotencyKey` (defaulting to a per-venue/contact/day key) so a repeat
   * scan returns the same walk-in rather than duplicating it.
   */
  async walkIn(ctx: TenantContext, dto: WalkInDto) {
    const t = ctx.tenantId;
    const phone = dto.phone?.trim() || undefined;
    const email = dto.email?.trim() || undefined;
    const hasContact = !!(phone || email || dto.walletPassId);
    const consented = dto.consent === true;
    // Enriched = durable, consented identity captured (a scanned wallet pass is
    // itself proof of an enrolled, identified guest).
    const enriched = !!dto.walletPassId || (hasContact && consented);

    // 1. Resolve an existing guest — wallet pass, then identity link, then a
    //    direct phone/email match — so returning walk-ins reuse their record.
    let guest = null as Awaited<
      ReturnType<PrismaService['guest']['findFirst']>
    >;
    if (dto.walletPassId) {
      guest = await this.prisma.guest.findFirst({
        where: { tenantId: t, walletPassId: dto.walletPassId },
      });
    }
    if (!guest && (phone || email)) {
      const pairs = [
        ...(phone
          ? [{ kind: IdentityLinkKind.phone, valueHash: sha256(phone) }]
          : []),
        ...(email
          ? [{ kind: IdentityLinkKind.email, valueHash: sha256(email) }]
          : []),
      ];
      const link = await this.prisma.identityLink.findFirst({
        where: { tenantId: t, OR: pairs },
      });
      if (link) {
        guest = await this.prisma.guest.findFirst({
          where: { id: link.guestId, tenantId: t },
        });
      }
      if (!guest) {
        guest = await this.prisma.guest.findFirst({
          where: {
            tenantId: t,
            OR: [
              ...(phone ? [{ primaryPhone: phone }] : []),
              ...(email ? [{ email }] : []),
            ],
          },
        });
      }
    }

    // 2. Create a fresh guest, or promote an existing provisional one now that
    //    we have consented contact.
    if (!guest) {
      guest = await this.identity.create(ctx, {
        primaryPhone: phone,
        email,
        displayName: dto.displayName,
        provisional: !enriched,
        walletPassId: dto.walletPassId,
      });
    } else if (enriched && guest.provisional) {
      guest = await this.prisma.guest.update({
        where: { id: guest.id },
        data: {
          provisional: false,
          primaryPhone: guest.primaryPhone ?? phone ?? null,
          email: guest.email ?? email ?? null,
          displayName: guest.displayName ?? dto.displayName ?? null,
        },
      });
    }
    const guestId = guest!.id;

    // 3. Persist identity links (verified when consented — that is what feeds
    //    the cross-tenant spine via IdentityService.addLink).
    if (phone) {
      await this.identity.addLink(ctx, guestId, {
        kind: IdentityLinkKind.phone,
        value: phone,
        verified: consented,
        source: 'door',
      });
    }
    if (email) {
      await this.identity.addLink(ctx, guestId, {
        kind: IdentityLinkKind.email,
        value: email,
        verified: consented,
        source: 'door',
      });
    }

    // 4. Record the door opt-in as a consent grant (the enrichment gate).
    let consentId: string | undefined;
    if (consented) {
      const grant = await this.prisma.consentGrant.create({
        data: {
          tenantId: t,
          guestId,
          scope: 'identity',
          basis: ConsentBasis.explicit,
          connector: 'door',
        },
      });
      consentId = grant.id;
    }

    // 5. Seat the walk-in as a booking (+ append-only status ledger), idempotent.
    const day = new Date().toISOString().slice(0, 10);
    const idempotencyKey =
      dto.idempotencyKey ??
      (hasContact
        ? evidenceDedupeKey(
            'walkin',
            `${dto.venueId}:${phone ?? email ?? dto.walletPassId}`,
            day,
          )
        : randomUUID());

    const existing = await this.prisma.booking.findUnique({
      where: { tenantId_idempotencyKey: { tenantId: t, idempotencyKey } },
    });
    if (existing) {
      return { guest, booking: existing, enriched: !guest!.provisional };
    }

    const booking = await this.prisma.$transaction(async (tx) => {
      const b = await tx.booking.create({
        data: {
          tenantId: t,
          venueId: dto.venueId,
          guestId,
          inventoryId: dto.inventoryId ?? null,
          status: 'seated',
          date: new Date(),
          partySize: dto.partySize ?? 1,
          idempotencyKey,
        },
      });
      await tx.bookingStatusEvent.create({
        data: {
          tenantId: t,
          bookingId: b.id,
          fromStatus: null,
          toStatus: 'seated',
          reason: 'walk-in',
        },
      });
      return b;
    });

    // 6. Publish the arrival as venue `attend` evidence (consent-tagged when given).
    await this.bus.publish({
      tenantId: t,
      guestId,
      subjectType: SubjectType.venue,
      subjectRef: dto.venueId,
      signal: Signal.attend,
      weight: 2,
      provenance: Provenance.booking,
      consentId,
      dedupeKey: evidenceDedupeKey('booking', booking.id, 'attend'),
      observedAt: new Date().toISOString(),
    });

    return { guest, booking, enriched: !guest!.provisional };
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

  @Post('walk-in')
  @Scopes('ops:door:write')
  walkIn(@Tenant() ctx: TenantContext, @Body() dto: WalkInDto) {
    return this.svc.walkIn(ctx, dto);
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [DoorlistController, DoorController],
  providers: [DoorService],
  exports: [DoorService],
})
export class DoorModule {}
