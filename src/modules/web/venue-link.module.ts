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
import { randomUUID } from 'crypto';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenancy/tenant-context';
import { sha256 } from '../../common/util/hash';
import { Provenance } from '@prisma/client';
import { BookingsModule, BookingsService } from '../ops/bookings.module';
import { AvailabilityService } from '../ops/availability.service';

class CheckoutDto {
  @IsString() displayName!: string;
  /** E.164. Verified by the express-pay sheet (Apple/Google Pay) or SMS OTP. */
  @IsString() phone!: string;
  @IsOptional() @IsEmail() email?: string;
  @IsString() date!: string;
  @IsOptional() @IsString() inventoryId?: string;
  @IsOptional() @IsInt() @Min(1) partySize?: number;
  /** True when identity arrived via an express-pay sheet (treated verified). */
  @IsOptional() expressPay?: boolean;
}

/**
 * Venue-link (ingest class 1b) — the public, pre-app booking surface.
 * docs/architecture/alist-journey-w2.md §7 + strategy-deltas-2026-07-21 §3.1.
 *
 * A venue's IG/bio link carries an AttributionLink code. That code — not a
 * bearer token — resolves the tenant, so these routes are public and are
 * excluded from TenantMiddleware. Rules enforced here:
 *   1. No signup wall: identity minimum is name + phone (+ payment, stubbed).
 *   2. Guest lands on a PROVISIONAL uid keyed on the verified phone hash; a
 *      later app signup merges via merge_identities (identity.service).
 *   3. Booking evidence carries `venue_link` provenance — single-venue intent
 *      that must not generalise across the graph pre-merge (W1 §4.3).
 *   4. Wallet pass id is issued at checkout: durable device-linked identifier
 *      and the pre-app update channel.
 */
@Injectable()
export class VenueLinkService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  private async resolveLink(code: string) {
    const link = await this.prisma.attributionLink.findUnique({
      where: { code },
    });
    if (!link || !link.venueId) throw new NotFoundException('Unknown link');
    return link as typeof link & { venueId: string };
  }

  /** V1 — the venue-branded live table map. Public; venue's customer moment. */
  async map(code: string, date?: string) {
    const link = await this.resolveLink(code);
    const ctx: TenantContext = { tenantId: link.tenantId, scopes: [] };

    const venue = await this.prisma.venue.findFirst({
      where: { id: link.venueId, tenantId: ctx.tenantId },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const inventory = await this.prisma.inventory.findMany({
      where: { tenantId: ctx.tenantId, venueId: link.venueId },
    });

    const range = AvailabilityService.dayRange(date);
    const tables = [] as Array<Record<string, unknown>>;
    for (const item of inventory) {
      const taken = await this.prisma.booking.count({
        where: {
          tenantId: ctx.tenantId,
          inventoryId: item.id,
          status: { not: 'cancelled' },
          ...(range ? { date: range } : {}),
        },
      });
      tables.push({
        id: item.id,
        kind: item.kind,
        label: item.label,
        capacity: item.capacity,
        minSpend: item.minSpend,
        deposit: item.deposit,
        available: taken < item.capacity,
      });
    }

    return {
      venue: { id: venue.id, name: venue.name, city: venue.city },
      campaignId: link.campaignId,
      date: date ?? null,
      tables,
      // A-List is present only as rails on this surface (venue-branded).
      poweredBy: 'A-List',
    };
  }

  /** V2/V3 — express checkout: provisional guest + booking + wallet pass. */
  async checkout(code: string, dto: CheckoutDto, idempotencyKey?: string) {
    const link = await this.resolveLink(code);
    const ctx: TenantContext = { tenantId: link.tenantId, scopes: [] };
    const phoneHash = sha256(dto.phone);

    // Reuse the guest a verified phone already points to (repeat web guest or
    // an existing app profile); otherwise mint a provisional uid.
    const existingLink = await this.prisma.identityLink.findUnique({
      where: {
        tenantId_kind_valueHash: {
          tenantId: ctx.tenantId,
          kind: 'phone',
          valueHash: phoneHash,
        },
      },
    });

    let guestId: string;
    let walletPassId: string | null = null;
    if (existingLink) {
      guestId = existingLink.guestId;
      const guest = await this.prisma.guest.findFirst({
        where: { id: guestId, tenantId: ctx.tenantId },
      });
      walletPassId = guest?.walletPassId ?? null;
    } else {
      walletPassId = `wp_${randomUUID()}`;
      const guest = await this.prisma.guest.create({
        data: {
          tenantId: ctx.tenantId,
          displayName: dto.displayName,
          primaryPhone: dto.phone,
          email: dto.email,
          provisional: true,
          walletPassId,
        },
      });
      guestId = guest.id;
      // Express-pay identity is verified by the pay sheet; the phone hash is
      // the primary merge key (email secondary).
      await this.prisma.identityLink.create({
        data: {
          tenantId: ctx.tenantId,
          guestId,
          kind: 'phone',
          valueHash: phoneHash,
          verified: dto.expressPay ?? true,
          source: 'venue_link',
        },
      });
      if (dto.email) {
        await this.prisma.identityLink.create({
          data: {
            tenantId: ctx.tenantId,
            guestId,
            kind: 'email',
            valueHash: sha256(dto.email),
            verified: dto.expressPay ?? false,
            source: 'venue_link',
          },
        });
      }
    }

    // Booking through the standard machinery (idempotency, inventory lock,
    // status ledger, metering) — with venue_link evidence provenance.
    const booking = await this.bookings.create(
      ctx,
      {
        venueId: link.venueId,
        guestId,
        inventoryId: dto.inventoryId,
        date: dto.date,
        partySize: dto.partySize,
        attributionId: link.id,
      },
      idempotencyKey,
      Provenance.venue_link,
    );

    // V3 — confirmation is the conversion moment, never before checkout.
    return {
      booking,
      walletPassId,
      provisionalGuestId: guestId,
      appDeepLink: `alist://signup?pg=${guestId}`,
      pitch:
        'Track your table, run your tab, split with your crew, rewards next visit — get A-List.',
    };
  }
}

@ApiTags('venue-link')
@Controller('v1/venue-link')
export class VenueLinkController {
  constructor(private readonly service: VenueLinkService) {}

  @Get(':code')
  map(@Param('code') code: string, @Query('date') date?: string) {
    return this.service.map(code, date);
  }

  @Post(':code/checkout')
  checkout(
    @Param('code') code: string,
    @Body() dto: CheckoutDto,
    @Headers('idempotency-key') idempotencyKey?: string,
  ) {
    return this.service.checkout(code, dto, idempotencyKey);
  }
}

@Module({
  imports: [BookingsModule],
  providers: [VenueLinkService],
  controllers: [VenueLinkController],
})
export class VenueLinkModule {}
