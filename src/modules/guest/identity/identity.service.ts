import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContext } from '../../../common/tenancy/tenant-context';
import { sha256 } from '../../../common/util/hash';
import { AddLinkDto, CreateGuestDto, MergeDto } from './dto';

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

  async create(ctx: TenantContext, dto: CreateGuestDto) {
    return this.prisma.guest.create({
      data: {
        tenantId: ctx.tenantId,
        primaryPhone: dto.primaryPhone,
        email: dto.email,
        displayName: dto.displayName,
        provisional: dto.provisional ?? true,
        walletPassId: dto.walletPassId,
      },
    });
  }

  async get(ctx: TenantContext, id: string) {
    const guest = await this.prisma.guest.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: { links: true, consents: { where: { revokedAt: null } } },
    });
    if (!guest) throw new NotFoundException('Guest not found');
    return guest;
  }

  async addLink(ctx: TenantContext, guestId: string, dto: AddLinkDto) {
    await this.get(ctx, guestId);
    return this.prisma.identityLink.upsert({
      where: {
        tenantId_kind_valueHash: {
          tenantId: ctx.tenantId,
          kind: dto.kind,
          valueHash: sha256(dto.value),
        },
      },
      create: {
        tenantId: ctx.tenantId,
        guestId,
        kind: dto.kind,
        valueHash: sha256(dto.value),
        verified: dto.verified ?? false,
        source: dto.source,
      },
      update: { guestId, verified: dto.verified ?? undefined },
    });
  }

  /**
   * merge_identities: collapse absorbed guests onto the surviving id. Reassigns
   * links, consents, evidence, affinity, crew memberships, bookings and
   * entitlements, and appends a reversible audit row (data-contract §6).
   */
  async merge(ctx: TenantContext, dto: MergeDto) {
    const surviving = await this.prisma.guest.findFirst({
      where: { id: dto.survivingId, tenantId: ctx.tenantId },
    });
    if (!surviving) throw new NotFoundException('Surviving guest not found');

    return this.prisma.$transaction(async (tx) => {
      for (const absorbedId of dto.absorbedIds) {
        const absorbed = await tx.guest.findFirst({
          where: { id: absorbedId, tenantId: ctx.tenantId },
        });
        if (!absorbed) continue;

        const where = { tenantId: ctx.tenantId, guestId: absorbedId };
        await tx.identityLink.updateMany({
          where,
          data: { guestId: dto.survivingId },
        });
        await tx.consentGrant.updateMany({
          where,
          data: { guestId: dto.survivingId },
        });
        await tx.affinityEvidence.updateMany({
          where,
          data: { guestId: dto.survivingId },
        });
        await tx.entitlement.updateMany({
          where,
          data: { guestId: dto.survivingId },
        });
        await tx.crewMember.updateMany({
          where: { guestId: absorbedId },
          data: { guestId: dto.survivingId },
        });
        await tx.booking.updateMany({
          where,
          data: { guestId: dto.survivingId },
        });
        // Derived affinity is recomputed lazily; clear the absorbed rows.
        await tx.guestAffinity.deleteMany({ where });

        await tx.identityMergeLog.create({
          data: {
            tenantId: ctx.tenantId,
            survivingId: dto.survivingId,
            absorbedId,
            reason: dto.reason,
          },
        });

        // Promote the surviving guest out of provisional if it was.
        if (!absorbed.provisional) {
          await tx.guest.update({
            where: { id: dto.survivingId },
            data: { provisional: false },
          });
        }
        // Tombstone the absorbed guest.
        await tx.guest.update({
          where: { id: absorbedId },
          data: { displayName: `[merged→${dto.survivingId}]` },
        });
      }
      return tx.guest.findUnique({ where: { id: dto.survivingId } });
    });
  }
}
