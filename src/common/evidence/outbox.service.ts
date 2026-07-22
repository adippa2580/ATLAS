import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { EvidenceBus, EvidenceMessage } from './evidence-bus';

/** Small, unit-testable summary of one drain pass. */
export interface DrainSummary {
  fetched: number;
  published: number;
  failed: number;
}

/**
 * Durable evidence outbox relay (transactional-outbox pattern).
 *
 * `TasteService.appendEvidence` writes the AffinityEvidence row and an
 * EvidenceOutbox row in the SAME transaction, so an enqueued message can never
 * be lost even if the process dies before delivery. This relay polls the outbox
 * and forwards each unpublished row's payload onto the in-process EvidenceBus,
 * marking it published on success. Delivery is at-least-once and survives a
 * restart (unpublished rows are re-drained); the recompute fold is idempotent so
 * a redelivery is harmless (P0-6).
 */
@Injectable()
export class OutboxRelayService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxRelayService.name);
  private static readonly POLL_MS = 1000;
  private static readonly BATCH = 100;

  private timer?: ReturnType<typeof setInterval>;
  // Guards against a slow drain overlapping the next tick.
  private draining = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      void this.tick();
    }, OutboxRelayService.POLL_MS);
  }

  onModuleDestroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** One non-overlapping poll cycle. */
  private async tick(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      await this.drainOnce();
    } catch (err) {
      this.logger.error(
        `outbox drain failed: ${err instanceof Error ? err.message : err}`,
      );
    } finally {
      this.draining = false;
    }
  }

  /**
   * Fetch a batch of unpublished rows (oldest first) and publish each. On a
   * successful publish the row is stamped `publishedAt`; on failure its
   * `attempts` counter is incremented and `publishedAt` is left null so the next
   * drain retries it. Returns a small summary for tests.
   */
  async drainOnce(): Promise<DrainSummary> {
    const rows = await this.prisma.evidenceOutbox.findMany({
      where: { publishedAt: null },
      orderBy: { createdAt: 'asc' },
      take: OutboxRelayService.BATCH,
    });

    let published = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        await this.bus.publish(row.payload as unknown as EvidenceMessage);
        await this.prisma.evidenceOutbox.update({
          where: { id: row.id },
          data: { publishedAt: new Date() },
        });
        published += 1;
      } catch (err) {
        failed += 1;
        this.logger.error(
          `outbox publish failed for ${row.id} (attempt ${row.attempts + 1}): ${
            err instanceof Error ? err.message : err
          }`,
        );
        await this.prisma.evidenceOutbox.update({
          where: { id: row.id },
          data: { attempts: { increment: 1 } },
        });
      }
    }

    return { fetched: rows.length, published, failed };
  }
}
