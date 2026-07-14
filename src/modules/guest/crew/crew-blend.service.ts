import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContext } from '../../../common/tenancy/tenant-context';
import { SubjectType } from '@prisma/client';

/**
 * Crew taste-composition (W2) — the load-bearing blend.
 * See docs/architecture/alist-journey-w2.md §6.
 *
 * Fixed interface: blend(crewId) -> crew_affinity rows. The implementation here
 * is the MVP heuristic; a learned model can replace it later without changing
 * this contract. Invariants that MUST hold for any implementation:
 *   1. Mutes are a hard union — if ANY member mutes a subject, it is excluded.
 *   2. Time-decay respected (carried in GuestAffinity.score).
 *   3. Bookings weigh most (carried in the score by the recompute worker).
 *   4. Deterministic + explainable (consensus boost is transparent).
 */
@Injectable()
export class CrewBlendService {
  constructor(private readonly prisma: PrismaService) {}

  async recompute(ctx: TenantContext, crewId: string): Promise<void> {
    const members = await this.prisma.crewMember.findMany({
      where: { crewId },
    });
    const guestIds = members.map((m) => m.guestId);
    if (guestIds.length === 0) return;

    const affinities = await this.prisma.guestAffinity.findMany({
      where: { tenantId: ctx.tenantId, guestId: { in: guestIds } },
    });

    // 1. Hard mute union.
    const muted = new Set<string>();
    for (const a of affinities) {
      if (a.muted) muted.add(this.key(a.subjectType, a.subjectRef));
    }

    // 2. Weighted combine + consensus boost.
    type Acc = { type: SubjectType; ref: string; sum: number; count: number };
    const acc = new Map<string, Acc>();
    for (const a of affinities) {
      const k = this.key(a.subjectType, a.subjectRef);
      if (muted.has(k) || a.muted) continue;
      const cur = acc.get(k) ?? {
        type: a.subjectType,
        ref: a.subjectRef,
        sum: 0,
        count: 0,
      };
      cur.sum += a.score;
      cur.count += 1;
      acc.set(k, cur);
    }

    const size = guestIds.length;
    const rows = Array.from(acc.values()).map((a) => {
      // Consensus boost: subjects shared across the crew are super-linear.
      const consensus = a.count / size; // 0..1
      const blendedScore = (a.sum / size) * (1 + consensus);
      // Confidence low when sparse/conflicting → recommender widens to safe picks.
      const confidence = Math.min(1, a.count / size);
      return {
        subjectType: a.type,
        subjectRef: a.ref,
        blendedScore,
        confidence,
      };
    });

    await this.prisma.$transaction([
      this.prisma.crewAffinity.deleteMany({ where: { crewId } }),
      this.prisma.crewAffinity.createMany({
        data: rows.map((r) => ({ crewId, ...r })),
      }),
    ]);
  }

  private key(type: SubjectType, ref: string): string {
    return `${type}:${ref}`;
  }
}
