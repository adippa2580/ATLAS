import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  EvidenceBus,
  EvidenceMessage,
} from '../../../common/evidence/evidence-bus';
import { Signal } from '@prisma/client';

/**
 * Recompute worker: subscribes to the evidence stream and folds each record into
 * the derived GuestAffinity, applying the graph rules
 * (docs/architecture/atlas-system-design.md §3.3):
 *   - mutes override all
 *   - bookings/spend weigh most
 *   - recent signal beats old (time-decay, applied incrementally here)
 *
 * MVP does incremental recompute on the hot path; a nightly full pass (not in
 * this build) reconciles decay. In prod this is a separate Pub/Sub subscriber.
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

  async apply(msg: EvidenceMessage): Promise<void> {
    const muted = msg.signal === Signal.mute;
    const contribution =
      (msg.weight ?? 1) * AffinityRecomputeService.SIGNAL_WEIGHT[msg.signal];

    const existing = await this.prisma.guestAffinity.findUnique({
      where: {
        tenantId_guestId_subjectType_subjectRef: {
          tenantId: msg.tenantId,
          guestId: msg.guestId,
          subjectType: msg.subjectType,
          subjectRef: msg.subjectRef,
        },
      },
    });

    // Simple exponential-ish blend: decay prior toward recent signal.
    const priorScore = existing?.score ?? 0;
    const decayedPrior = priorScore * 0.9;
    const nextScore = muted ? priorScore : decayedPrior + contribution;

    await this.prisma.guestAffinity.upsert({
      where: {
        tenantId_guestId_subjectType_subjectRef: {
          tenantId: msg.tenantId,
          guestId: msg.guestId,
          subjectType: msg.subjectType,
          subjectRef: msg.subjectRef,
        },
      },
      create: {
        tenantId: msg.tenantId,
        guestId: msg.guestId,
        subjectType: msg.subjectType,
        subjectRef: msg.subjectRef,
        score: nextScore,
        muted,
      },
      update: {
        score: nextScore,
        muted: muted || existing?.muted || false,
        decayedAt: new Date(),
      },
    });

    this.logger.debug(
      `affinity ${msg.guestId} ${msg.subjectType}:${msg.subjectRef} -> ${nextScore.toFixed(2)}${muted ? ' (muted)' : ''}`,
    );
  }
}
