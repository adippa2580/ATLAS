import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubjectType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/**
 * "Blend" (Team INS-BLEND) — the ATLAS-native taste-blend surface. Blend has no
 * third-party API; it is computed entirely from our own taste graph:
 *   GET /insights/venue-blend  — the crowd-blend of a venue's recent room
 *   GET /insights/guest-blend  — Spotify-Blend-style overlap of two guests
 *   GET /insights/crew-blend   — surfaces the crew blend CrewBlendService owns
 *
 * The consensus-boost math is the same one CrewBlendService recomputes (see
 * src/modules/guest/crew/crew-blend.service.ts): per subject key we accumulate
 * sum(score) + count across the cohort, then
 *   blendedScore = (sum / N) * (1 + count / N)   confidence = min(1, count / N)
 * with a HARD MUTE UNION — a mute by any cohort member vetoes the subject.
 * Read-only + tenant-scoped; no money is involved anywhere here.
 */

// ---------------------------------------------------------------------------
// Pure helpers (kept in-file, mirroring the ops-insights house style)
// ---------------------------------------------------------------------------

/** Minimal shape of a GuestAffinity row the blend math needs. */
type AffinityRow = {
  guestId: string;
  subjectType: SubjectType;
  subjectRef: string;
  score: number;
  muted: boolean;
};

/** A composed blend row, keyed by `${subjectType}:${subjectRef}`. */
type BlendRow = {
  subjectType: SubjectType;
  subjectRef: string;
  blendedScore: number;
  confidence: number;
};

const key = (type: SubjectType, ref: string): string => `${type}:${ref}`;

const round = (n: number, dp: number): number => {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
};

/**
 * Consensus-boost over a cohort of size `cohortSize`. Identical math to
 * CrewBlendService (invariant 1: mutes are a hard union). Returns one BlendRow
 * per surviving subject; excludes any subject muted by ANY cohort member.
 */
function consensusBlend(
  affinities: AffinityRow[],
  cohortSize: number,
): BlendRow[] {
  if (cohortSize === 0) return [];

  // Hard mute union first — a single mute vetoes the subject for everyone.
  const muted = new Set<string>();
  for (const a of affinities) {
    if (a.muted) muted.add(key(a.subjectType, a.subjectRef));
  }

  type Acc = { type: SubjectType; ref: string; sum: number; count: number };
  const acc = new Map<string, Acc>();
  for (const a of affinities) {
    const k = key(a.subjectType, a.subjectRef);
    if (muted.has(k)) continue;
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

  return Array.from(acc.values()).map((a) => {
    const consensus = a.count / cohortSize; // 0..1
    return {
      subjectType: a.type,
      subjectRef: a.ref,
      blendedScore: (a.sum / cohortSize) * (1 + consensus),
      confidence: Math.min(1, a.count / cohortSize),
    };
  });
}

/** Top-N BlendRows of one subject type, sorted by blendedScore, as {ref,score,confidence}. */
function topBySubject(rows: BlendRow[], type: SubjectType, n = 8) {
  return rows
    .filter((r) => r.subjectType === type)
    .sort((a, b) => b.blendedScore - a.blendedScore)
    .slice(0, n)
    .map((r) => ({
      ref: r.subjectRef,
      score: round(r.blendedScore, 3),
      confidence: round(r.confidence, 2),
    }));
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class BlendService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Venue crowd-blend (operator). Cohort = distinct guests with a non-cancelled
   * booking at the venue in the last `days`, whose identity is enriched
   * (provisional:false) and who carry a live marketing/identity consent. The
   * consent + provisional gate is enforced in the guest query, so the cohort is
   * already clean by the time we read affinities.
   */
  async venueBlend(ctx: TenantContext, venueId?: string, days = 30) {
    const t = ctx.tenantId;
    const windowDays = Number.isFinite(days) && days > 0 ? days : 30;

    // Resolve the tenant's first venue when none is supplied.
    let vid = venueId;
    if (!vid) {
      const venue = await this.prisma.venue.findFirst({
        where: { tenantId: t },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
      vid = venue?.id;
    }
    if (!vid) {
      return {
        venueId: null,
        windowDays,
        guests: 0,
        topArtists: [],
        topGenres: [],
        summary: 'No venue found for this tenant yet.',
      };
    }

    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
    const recent = await this.prisma.booking.findMany({
      where: {
        tenantId: t,
        venueId: vid,
        status: { not: 'cancelled' },
        date: { gte: since },
      },
      select: { guestId: true },
    });
    const bookedGuestIds = [...new Set(recent.map((b) => b.guestId))];

    // Consent + provisional gate, pushed into the query.
    const cohort = bookedGuestIds.length
      ? await this.prisma.guest.findMany({
          where: {
            tenantId: t,
            id: { in: bookedGuestIds },
            provisional: false,
            consents: {
              some: {
                revokedAt: null,
                scope: { in: ['marketing', 'identity'] },
              },
            },
          },
          select: { id: true },
        })
      : [];
    const cohortIds = cohort.map((g) => g.id);
    const n = cohortIds.length;

    if (n === 0) {
      return {
        venueId: vid,
        windowDays,
        guests: 0,
        topArtists: [],
        topGenres: [],
        summary: `No consented, enriched guests booked this venue in the last ${windowDays} days.`,
      };
    }

    const affinities = await this.prisma.guestAffinity.findMany({
      where: { tenantId: t, guestId: { in: cohortIds } },
      select: {
        guestId: true,
        subjectType: true,
        subjectRef: true,
        score: true,
        muted: true,
      },
    });

    const blended = consensusBlend(affinities, n);
    const topArtists = topBySubject(blended, SubjectType.artist);
    const topGenres = topBySubject(blended, SubjectType.genre);

    let summary: string;
    if (topArtists.length === 0 && topGenres.length === 0) {
      summary = `${n} guests booked this venue but none carry taste affinities yet.`;
    } else {
      const g1 = topGenres[0]?.ref;
      const g2 = topGenres[1]?.ref;
      const a1 = topArtists[0]?.ref;
      const genrePart = g2 ? `${g1} / ${g2}` : (g1 ?? 'a mixed set of genres');
      const artistPart = a1 ? ` — top artist ${a1}.` : '.';
      summary = `The room skews ${genrePart}${artistPart}`;
    }

    return {
      venueId: vid,
      windowDays,
      guests: n,
      topArtists,
      topGenres,
      summary,
    };
  }

  /**
   * Guest-to-guest blend (Spotify-Blend-style). Both guests must be in the
   * caller's tenant. A subject muted by EITHER guest is dropped from both the
   * shared set and the union, so blendScore is a Jaccard % over live tastes.
   */
  async guestBlend(ctx: TenantContext, guestA: string, guestB: string) {
    const t = ctx.tenantId;

    const rows = await this.prisma.guestAffinity.findMany({
      where: { tenantId: t, guestId: { in: [guestA, guestB] } },
      select: {
        guestId: true,
        subjectType: true,
        subjectRef: true,
        score: true,
        muted: true,
      },
    });

    // Mute union across both guests.
    const muted = new Set<string>();
    for (const r of rows) {
      if (r.muted) muted.add(key(r.subjectType, r.subjectRef));
    }

    type Side = { type: SubjectType; ref: string; score: number };
    const a = new Map<string, Side>();
    const b = new Map<string, Side>();
    for (const r of rows) {
      const k = key(r.subjectType, r.subjectRef);
      if (muted.has(k)) continue;
      const side = r.guestId === guestA ? a : b;
      side.set(k, { type: r.subjectType, ref: r.subjectRef, score: r.score });
    }

    // Union over non-muted subjects of both; shared = present in both.
    const union = new Set<string>([...a.keys(), ...b.keys()]);
    const shared: Array<{
      type: SubjectType;
      ref: string;
      combinedScore: number;
    }> = [];
    for (const [k, sa] of a) {
      const sb = b.get(k);
      if (!sb) continue;
      shared.push({
        type: sa.type,
        ref: sa.ref,
        combinedScore: round(Math.min(sa.score, sb.score), 3),
      });
    }

    const sharedCount = shared.length;
    const unionCount = union.size;
    const blendScore =
      unionCount === 0 ? 0 : Math.round((100 * sharedCount) / unionCount);

    const pick = (type: SubjectType) =>
      shared
        .filter((s) => s.type === type)
        .sort((x, y) => y.combinedScore - x.combinedScore)
        .slice(0, 8)
        .map((s) => ({ ref: s.ref, combinedScore: s.combinedScore }));

    const base = {
      guestA,
      guestB,
      blendScore,
      sharedCount,
      topSharedArtists: pick(SubjectType.artist),
      topSharedGenres: pick(SubjectType.genre),
    };

    if (sharedCount === 0) {
      return {
        ...base,
        message: 'No overlapping taste between these two guests yet.',
      };
    }
    return base;
  }

  /**
   * Crew blend (read-only). CrewBlendService owns the recompute; here we simply
   * surface the stored CrewAffinity rows and derive a "who to book" nudge.
   */
  async crewBlend(ctx: TenantContext, crewId: string) {
    const t = ctx.tenantId;

    const rows = await this.prisma.crewAffinity.findMany({
      where: { tenantId: t, crewId },
      orderBy: { blendedScore: 'desc' },
      select: {
        subjectType: true,
        subjectRef: true,
        blendedScore: true,
        confidence: true,
      },
    });

    if (rows.length === 0) {
      return {
        crewId,
        topArtists: [],
        topGenres: [],
        bookHint: null,
        message: 'This crew has no computed blend yet.',
      };
    }

    const split = (type: SubjectType) =>
      rows
        .filter((r) => r.subjectType === type)
        .slice(0, 8)
        .map((r) => ({
          ref: r.subjectRef,
          score: round(r.blendedScore, 3),
          confidence: round(r.confidence, 2),
        }));

    const topArtists = split(SubjectType.artist);
    const topGenres = split(SubjectType.genre);

    // Prefer the strongest artist as a booking nudge; fall back to top genre.
    let bookHint: string | null = null;
    if (topArtists.length) {
      bookHint = `Book ${topArtists[0].ref} — the crew's strongest artist affinity.`;
    } else if (topGenres.length) {
      bookHint = `Program a ${topGenres[0].ref} night — the crew's strongest genre.`;
    }

    return { crewId, topArtists, topGenres, bookHint };
  }
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('insights')
@Controller('insights')
export class BlendController {
  constructor(private readonly svc: BlendService) {}

  /** Venue crowd-blend — the taste shape of a venue's recent, consented room. */
  @Get('venue-blend')
  @Scopes('mkt:reporting:read')
  venueBlend(
    @Tenant() ctx: TenantContext,
    @Query('venueId') venueId?: string,
    @Query('days') days?: string,
  ) {
    return this.svc.venueBlend(
      ctx,
      venueId,
      days === undefined ? undefined : Number(days),
    );
  }

  /** Guest-to-guest blend — overlap % + shared tastes between two guests. */
  @Get('guest-blend')
  @Scopes('mkt:reporting:read')
  guestBlend(
    @Tenant() ctx: TenantContext,
    @Query('guestA') guestA: string,
    @Query('guestB') guestB: string,
  ) {
    return this.svc.guestBlend(ctx, guestA, guestB);
  }

  /** Crew blend — surfaces the crew's stored blend + a booking nudge. */
  @Get('crew-blend')
  @Scopes('mkt:reporting:read')
  crewBlend(@Tenant() ctx: TenantContext, @Query('crewId') crewId: string) {
    return this.svc.crewBlend(ctx, crewId);
  }
}

// ---------------------------------------------------------------------------
// Module
// ---------------------------------------------------------------------------

@Module({
  controllers: [BlendController],
  providers: [BlendService],
  exports: [BlendService],
})
export class BlendModule {}
