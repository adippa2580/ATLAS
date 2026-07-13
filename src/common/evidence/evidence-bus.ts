import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Provenance, Signal, SubjectType } from '@prisma/client';

/**
 * A single affinity-evidence record as it travels on the bus. This is the ONLY
 * shape that carries taste into the graph (docs/architecture/data-contract §3).
 */
export interface EvidenceMessage {
  tenantId: string;
  guestId: string;
  subjectType: SubjectType;
  subjectRef: string;
  signal: Signal;
  weight: number;
  provenance: Provenance;
  consentId?: string;
  dedupeKey: string;
  observedAt: string;
}

export type EvidenceHandler = (msg: EvidenceMessage) => Promise<void>;

/**
 * Transport for the evidence stream. Local dev uses an in-memory implementation;
 * GCP uses Pub/Sub (config EVIDENCE_BUS=pubsub). The recompute worker subscribes
 * here; modelling this as a stream from day one means scaling = more consumers,
 * not a re-architecture (system-design §2.2).
 */
@Injectable()
export class EvidenceBus {
  private readonly logger = new Logger(EvidenceBus.name);
  private readonly handlers: EvidenceHandler[] = [];

  constructor(private readonly config: ConfigService) {}

  subscribe(handler: EvidenceHandler): void {
    this.handlers.push(handler);
  }

  async publish(msg: EvidenceMessage): Promise<void> {
    const mode = this.config.get<string>('evidenceBus');
    if (mode === 'pubsub') {
      // In prod this publishes to Pub/Sub topic `pubsubEvidenceTopic`; the
      // recompute worker is a separate subscriber. Kept as a log in this build
      // so the app runs without cloud credentials.
      this.logger.debug(
        `[pubsub-stub] evidence ${msg.signal} ${msg.subjectType}:${msg.subjectRef}`,
      );
    }
    // Fan out to in-process subscribers (the recompute worker) — at-least-once;
    // dedupeKey makes duplicates harmless.
    await Promise.all(
      this.handlers.map((h) =>
        h(msg).catch((err) =>
          this.logger.error(`evidence handler failed: ${err.message}`),
        ),
      ),
    );
  }
}
