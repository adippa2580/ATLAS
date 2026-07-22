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
    const link = await this.prisma.identityLink.upsert({
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

    // A verified link is the anchor for the cross-tenant identity spine. Attempt
    // spine resolution best-effort so a spine hiccup never fails the link write.
    if (link.verified) {
      try {
        await this.ensureGlobalGuest(ctx, guestId);
      } catch {
        // best-effort: spine linkage is append-only and can be retried later.
      }
    }

    return link;
  }

  /**
   * Resolve (or create) the cross-tenant identity spine for a guest and return
   * its globalGuestId. Append-only and non-destructive: it only ever SETS a
   * guest's globalGuestId, never reassigns or collapses existing spines.
   *
   * Rule:
   *  1. If the guest already sits on a spine, return it.
   *  2. Otherwise, if ANOTHER guest (in any tenant) shares one of this guest's
   *     VERIFIED IdentityLinks (same kind + valueHash, verified) and already has
   *     a spine, adopt that spine.
   *  3. Otherwise mint a fresh GlobalGuest and attach it.
   */
  async ensureGlobalGuest(
    ctx: TenantContext,
    guestId: string,
  ): Promise<string> {
    const guest = await this.prisma.guest.findFirst({
      where: { id: guestId, tenantId: ctx.tenantId },
      include: { links: { where: { verified: true } } },
    });
    if (!guest) throw new NotFoundException('Guest not found');
    if (guest.globalGuestId) return guest.globalGuestId;

    // Look for another guest — deliberately NOT tenant-scoped — that shares one
    // of this guest's verified links and already has a spine, and adopt it.
    const verifiedPairs = guest.links.map((l) => ({
      kind: l.kind,
      valueHash: l.valueHash,
    }));
    if (verifiedPairs.length > 0) {
      const match = await this.prisma.identityLink.findFirst({
        where: {
          verified: true,
          guestId: { not: guestId },
          OR: verifiedPairs,
          guest: { globalGuestId: { not: null } },
        },
        include: { guest: { select: { globalGuestId: true } } },
      });
      if (match?.guest?.globalGuestId) {
        await this.prisma.guest.update({
          where: { id: guestId },
          data: { globalGuestId: match.guest.globalGuestId },
        });
        return match.guest.globalGuestId;
      }
    }

    // No shared spine exists yet — mint a new one and attach this guest.
    const spine = await this.prisma.globalGuest.create({ data: {} });
    await this.prisma.guest.update({
      where: { id: guestId },
      data: { globalGuestId: spine.id },
    });
    return spine.id;
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

    const result = await this.prisma.$transaction(async (tx) => {
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

    // Post-merge, ensure the surviving guest is anchored to the identity spine.
    // Best-effort so spine linkage never rolls back a completed merge.
    try {
      await this.ensureGlobalGuest(ctx, dto.survivingId);
    } catch {
      // best-effort: append-only spine link can be retried later.
    }

    return result;
  }
}
