import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EvidenceBus } from '../../../common/evidence/evidence-bus';
import { TenantContext } from '../../../common/tenancy/tenant-context';
import { Prisma, Signal } from '@prisma/client';
import { AppendEvidenceDto, MuteDto } from './dto';
import { sha256 } from '../../../common/util/hash';

@Injectable()
export class TasteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  /**
   * The ONLY write path into the taste graph. Appends a consent-tagged,
   * provenance-tagged evidence record and publishes it to the recompute stream.
   * Idempotent on (tenantId, dedupeKey).
   */
  async appendEvidence(ctx: TenantContext, dto: AppendEvidenceDto) {
    // Consent is a hard dependency for connector-sourced signal.
    if (dto.consentId) {
      const consent = await this.prisma.consentGrant.findFirst({
        where: { id: dto.consentId, tenantId: ctx.tenantId, revokedAt: null },
      });
      if (!consent) {
        throw new NotFoundException(
          'No active consent grant for this evidence',
        );
      }
    }

    const observedAt = new Date();

    // Append-only: try to INSERT a fresh evidence row. A unique-violation on
    // (tenantId, dedupeKey) means this is a duplicate / at-least-once redelivery
    // — return the existing row and do NOT publish, so the derived affinity is
    // never re-applied for the same evidence (P0-6: evidence double-count).
    let record;
    try {
      record = await this.prisma.affinityEvidence.create({
        data: {
          tenantId: ctx.tenantId,
          guestId: dto.guestId,
          subjectType: dto.subjectType,
          subjectRef: dto.subjectRef,
          signal: dto.signal,
          weight: dto.weight ?? 1,
          provenance: dto.provenance,
          consentId: dto.consentId,
          dedupeKey: dto.dedupeKey,
          observedAt,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Duplicate dedupeKey — the original evidence stands unchanged and was
        // already published on first insert. Return it without republishing.
        return this.prisma.affinityEvidence.findUnique({
          where: {
            tenantId_dedupeKey: {
              tenantId: ctx.tenantId,
              dedupeKey: dto.dedupeKey,
            },
          },
        });
      }
      throw err;
    }

    // Only genuinely-new evidence is published into the recompute stream.
    await this.bus.publish({
      tenantId: ctx.tenantId,
      guestId: dto.guestId,
      subjectType: dto.subjectType,
      subjectRef: dto.subjectRef,
      signal: dto.signal,
      weight: dto.weight ?? 1,
      provenance: dto.provenance,
      consentId: dto.consentId,
      dedupeKey: dto.dedupeKey,
      observedAt: observedAt.toISOString(),
    });

    return record;
  }

  /** Raw append-only evidence for a guest — the actual writes into the graph. */
  async listEvidence(ctx: TenantContext, guestId: string) {
    return this.prisma.affinityEvidence.findMany({
      where: { tenantId: ctx.tenantId, guestId },
      orderBy: { observedAt: 'desc' },
      take: 25,
    });
  }

  /** Resolved taste: derived affinity with mutes applied, ranked. */
  async getAffinity(ctx: TenantContext, guestId: string) {
    const rows = await this.prisma.guestAffinity.findMany({
      where: { tenantId: ctx.tenantId, guestId, muted: false },
      orderBy: { score: 'desc' },
    });
    return rows;
  }

  /** Hard "no" — overrides all. Written as mute evidence. */
  async mute(ctx: TenantContext, guestId: string, dto: MuteDto) {
    const dedupeKey = sha256('mute', guestId, dto.subjectType, dto.subjectRef);
    return this.appendEvidence(ctx, {
      guestId,
      subjectType: dto.subjectType,
      subjectRef: dto.subjectRef,
      signal: Signal.mute,
      provenance: 'connector' as any,
      dedupeKey,
    });
  }
}
