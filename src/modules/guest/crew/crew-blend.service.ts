import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { TenantContext } from '../../../common/tenancy/tenant-context';
import { SubjectType } from '@prisma/client';

/**
 * Crew taste-composition (W2) — the load-bearing blend.
 * See docs/architecture/alist-journey-w2.md §6 + strategy-deltas-2026-07-21 §2.
 *
 * Fixed interface: blend(crewId) -> crew_affinity rows. The implementation here
 * is the MVP heuristic; a learned model can replace it later without changing
 * this contract. Invariants that MUST hold for any implementation:
 *   1. Mutes are a hard union — if ANY member mutes a subject, it is excluded.
 *   2. Time-decay respected (carried in GuestAffinity.score).
 *   3. Bookings weigh most (carried in the score by the recompute worker).
 *   4. Deterministic + explainable (consensus boost is transparent).
 *
 * ADOPTED 2026-07-21 (pending Jack ratification — strategy-deltas §2.1/§2.2):
 *   5. Booking-backed member contributions are up-weighted (w_m = 1.5) so a
 *      member who actually paid for this taste outweighs one who browsed it.
 *   6. Crew-node learning: the crew's own booking history writes a posterior
 *      on top of the composed prior. Composition is cold-start; as crew-level
 *      bookings accumulate the crew's realised behaviour dominates.
 */
@Injectable()
export class CrewBlendService {
  constructor(private readonly prisma: PrismaService) {}

  async recompute(ctx: TenantContext, crewId: string): Promise<void> {
    // Tenant-scoping (P0-2): the crew must belong to the caller's tenant, and
    // every crew read/write below is scoped by tenantId. A single recompute
    // operates entirely within one tenant.
    const crew = await this.prisma.crew.findUnique({ where: { id: crewId } });
    if (!crew || crew.tenantId !== ctx.tenantId) {
      throw new NotFoundException('Crew not found for tenant');
    }

    const members = await this.prisma.crewMember.findMany({
      where: { tenantId: ctx.tenantId, crewId },
    });
    const guestIds = members.map((m) => m.guestId);
    if (guestIds.length === 0) {
      // Still clear any stale blend for this crew within the tenant.
      await this.prisma.crewAffinity.deleteMany({
        where: { tenantId: ctx.tenantId, crewId },
      });
      return;
    }

    const affinities = await this.prisma.guestAffinity.findMany({
      where: { tenantId: ctx.tenantId, guestId: { in: guestIds } },
    });

    // Invariant 5: which (member, subject) pairs are backed by paid evidence.
    const paidEvidence = await this.prisma.affinityEvidence.findMany({
      where: {
        tenantId: ctx.tenantId,
        guestId: { in: guestIds },
        provenance: { in: ['booking', 'pos', 'venue_link'] },
      },
      select: { guestId: true, subjectType: true, subjectRef: true },
    });
    const paidKeys = new Set(
      paidEvidence.map(
        (e) => `${e.guestId}|${this.key(e.subjectType, e.subjectRef)}`,
      ),
    );
    const BOOKING_MEMBER_WEIGHT = 1.5;

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
      const w = paidKeys.has(`${a.guestId}|${k}`) ? BOOKING_MEMBER_WEIGHT : 1;
      cur.sum += a.score * w;
      cur.count += 1;
      acc.set(k, cur);
    }

    const size = guestIds.length;
    type Row = {
      subjectType: SubjectType;
      subjectRef: string;
      blendedScore: number;
      confidence: number;
    };
    const composed = new Map<string, Row>(
      Array.from(acc.entries()).map(([k, a]): [string, Row] => {
        // Consensus boost: subjects shared across the crew are super-linear.
        const consensus = a.count / size; // 0..1
        const blendedScore = (a.sum / size) * (1 + consensus);
        // Confidence low when sparse/conflicting → recommender widens to safe picks.
        const confidence = Math.min(1, a.count / size);
        return [
          k,
          { subjectType: a.type, subjectRef: a.ref, blendedScore, confidence },
        ];
      }),
    );

    // Invariant 6: crew-history posterior. Each realised crew booking at a
    // venue adds the full booking weight (3, matching the evidence bus) on the
    // crew node itself, so history outgrows the composed prior linearly.
    const CREW_BOOKING_WEIGHT = 3;
    const history = await this.prisma.booking.groupBy({
      by: ['venueId'],
      where: {
        tenantId: ctx.tenantId,
        crewId,
        status: { not: 'cancelled' },
      },
      _count: { _all: true },
    });
    for (const h of history) {
      const k = this.key(SubjectType.venue, h.venueId);
      const n = h._count._all;
      const boost = CREW_BOOKING_WEIGHT * n;
      const muteBlocked = muted.has(k);
      if (muteBlocked) continue; // a mute still vetoes even realised history
      const cur = composed.get(k);
      if (cur) {
        cur.blendedScore += boost;
        cur.confidence = Math.min(1, cur.confidence + 0.25 * n);
      } else {
        composed.set(k, {
          subjectType: SubjectType.venue,
          subjectRef: h.venueId,
          blendedScore: boost,
          confidence: Math.min(1, 0.25 * n),
        });
      }
    }

    const rows = Array.from(composed.values());

    await this.prisma.$transaction([
      this.prisma.crewAffinity.deleteMany({
        where: { tenantId: ctx.tenantId, crewId },
      }),
      this.prisma.crewAffinity.createMany({
        data: rows.map((r) => ({ tenantId: ctx.tenantId, crewId, ...r })),
      }),
    ]);
  }

  private key(type: SubjectType, ref: string): string {
    return `${type}:${ref}`;
  }
}
