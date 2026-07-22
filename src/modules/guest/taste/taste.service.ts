import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EvidenceMessage } from '../../../common/evidence/evidence-bus';
import { TenantContext } from '../../../common/tenancy/tenant-context';
import { Prisma, Signal } from '@prisma/client';
import { AppendEvidenceDto, MuteDto } from './dto';
import { sha256 } from '../../../common/util/hash';

@Injectable()
export class TasteService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The ONLY write path into the taste graph. Appends a consent-tagged,
   * provenance-tagged evidence record and, in the SAME transaction, enqueues an
   * EvidenceOutbox row (transactional-outbox pattern) so the recompute message
   * can never be lost. The OutboxRelayService delivers it onto the bus.
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

    // The recompute message, identical to what was published inline before the
    // outbox existed. This is the payload the relay forwards onto the bus and
    // that AffinityRecomputeService.apply consumes.
    const message: EvidenceMessage = {
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
    };

    // Append-only + durable enqueue in ONE transaction: insert the fresh
    // evidence row AND its outbox row atomically, so the recompute message is
    // never lost even if the process dies before delivery.
    //
    // A unique-violation on (tenantId, dedupeKey) means this is a duplicate /
    // at-least-once redelivery — the whole tx rolls back (no evidence row, no
    // outbox row enqueued) and we return the existing row, so the derived
    // affinity is never re-applied for the same evidence (P0-6: double-count).
    try {
      return await this.prisma.$transaction(async (tx) => {
        const record = await tx.affinityEvidence.create({
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

        await tx.evidenceOutbox.create({
          data: {
            tenantId: ctx.tenantId,
            payload: message as unknown as Prisma.InputJsonValue,
            dedupeKey: dto.dedupeKey,
          },
        });

        return record;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        // Duplicate dedupeKey — the original evidence stands unchanged and was
        // already enqueued on first insert. Return it without re-enqueuing.
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
