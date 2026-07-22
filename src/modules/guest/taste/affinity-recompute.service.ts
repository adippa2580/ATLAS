import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EvidenceBus,
  EvidenceMessage,
} from '../../../common/evidence/evidence-bus';
import { Signal, SubjectType } from '@prisma/client';

/**
 * Recompute worker: subscribes to the evidence stream and rebuilds the derived
 * GuestAffinity for a subject by folding DETERMINISTICALLY over the immutable
 * AffinityEvidence log, applying the graph rules
 * (docs/architecture/atlas-system-design.md §3.3):
 *   - mutes override (latest mute vs. positive signal wins → un-mute path)
 *   - bookings/spend weigh most
 *
 * The fold is a pure function of the evidence log, so an at-least-once
 * redelivery is harmless and a full replay reproduces the same state (P0-6).
 * Evidence gated by a REVOKED consent is excluded from the fold (P0-8), so
 * revoking consent purges the derived taste it contributed.
 *
 * In prod this is a separate Pub/Sub subscriber.
 */
@Injectable()
export class AffinityRecomputeService implements OnModuleInit {
  private readonly logger = new Logger(AffinityRecomputeService.name);

  // Signal → base contribution. Paid actions dominate browsing.
  private static readonly SIGNAL_WEIGHT: Record<Signal, number> = {
    [Signal.mute]: 0,
    [Signal.follow]: 1,
    [Signal.listen]: 1.5,
    [Signal.attend]: 3,
    [Signal.loyalty]: 3,
    [Signal.book]: 4,
    [Signal.spend]: 5,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  onModuleInit(): void {
    this.bus.subscribe((msg) => this.apply(msg));
  }

  /** Stream handler — a redelivery just recomputes the same subject. */
  async apply(msg: EvidenceMessage): Promise<void> {
    await this.recomputeSubject(
      msg.tenantId,
      msg.guestId,
      msg.subjectType,
      msg.subjectRef,
    );
  }

  /**
   * Deterministically rebuild the derived affinity for one
   * (tenantId, guestId, subjectType, subjectRef) key by folding over its
   * immutable evidence log. Idempotent and replay-safe.
   *
   * Excludes evidence gated by a revoked consent (no consent, or a consent
   * whose revokedAt is null). Mute/un-mute is resolved by time order: the
   * latest mute suppresses; a later positive signal clears it.
   */
  async recomputeSubject(
    tenantId: string,
    guestId: string,
    subjectType: SubjectType,
    subjectRef: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const evidence = await tx.affinityEvidence.findMany({
        where: {
          tenantId,
          guestId,
          subjectType,
          subjectRef,
          // Consent revocation purges derived taste (P0-8): fold only over
          // evidence with no consent or a still-active consent.
          OR: [{ consentId: null }, { consent: { revokedAt: null } }],
        },
        orderBy: { observedAt: 'asc' },
      });

      let score = 0;
      let muted = false;
      for (const e of evidence) {
        if (e.signal === Signal.mute) {
          muted = true;
        } else {
          // A later positive signal clears a prior mute (un-mute path).
          muted = false;
          score +=
            (e.weight ?? 1) * AffinityRecomputeService.SIGNAL_WEIGHT[e.signal];
        }
      }

      await tx.guestAffinity.upsert({
        where: {
          tenantId_guestId_subjectType_subjectRef: {
            tenantId,
            guestId,
            subjectType,
            subjectRef,
          },
        },
        create: { tenantId, guestId, subjectType, subjectRef, score, muted },
        update: { score, muted, decayedAt: new Date() },
      });

      this.logger.debug(
        `affinity ${guestId} ${subjectType}:${subjectRef} -> ${score.toFixed(2)}${muted ? ' (muted)' : ''}`,
      );
    });
  }
}
