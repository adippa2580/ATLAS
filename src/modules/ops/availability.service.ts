import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContext } from '../../common/tenancy/tenant-context';

export interface RankOpts {
  party?: number;
  crewId?: string;
  guestId?: string;
}

/**
 * Shared crew/guest-aware inventory ranking used by both Bookings availability
 * (#9) and Demand Routing (#14). A simple heuristic join: base the score on the
 * crew's (or guest's) resolved affinity for the venue, then bias toward the
 * table whose capacity best fits the party. The learned blend lands later (W2).
 */
@Injectable()
export class AvailabilityService {
  constructor(private readonly prisma: PrismaService) {}

  /** Start-of-day .. next-day range for a `YYYY-MM-DD` (or ISO) date string. */
  static dayRange(date?: string): { gte: Date; lt: Date } | undefined {
    if (!date) return undefined;
    const start = new Date(date);
    if (Number.isNaN(start.getTime())) return undefined;
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 1);
    return { gte: start, lt: end };
  }

  async rank(ctx: TenantContext, venueId: string, opts: RankOpts) {
    const inventory = await this.prisma.inventory.findMany({
      where: {
        tenantId: ctx.tenantId,
        venueId,
        ...(opts.party ? { capacity: { gte: opts.party } } : {}),
      },
    });

    // Base affinity: crew blend if a crew is supplied, else the guest's own.
    let base = 0;
    if (opts.crewId) {
      const crewAff = await this.prisma.crewAffinity.findFirst({
        where: {
          tenantId: ctx.tenantId,
          crewId: opts.crewId,
          subjectType: 'venue',
          subjectRef: venueId,
        },
      });
      base = crewAff?.blendedScore ?? 0;
    } else if (opts.guestId) {
      const guestAff = await this.prisma.guestAffinity.findFirst({
        where: {
          tenantId: ctx.tenantId,
          guestId: opts.guestId,
          subjectType: 'venue',
          subjectRef: venueId,
          muted: false,
        },
      });
      base = guestAff?.score ?? 0;
    }

    const party = opts.party ?? 0;
    const ranked = inventory
      .map((item) => ({
        ...item,
        // Higher affinity ranks first; break ties by the tightest capacity fit.
        rankScore: base - Math.abs(item.capacity - party) * 0.01,
      }))
      .sort((a, b) => b.rankScore - a.rankScore);

    return ranked;
  }
}
