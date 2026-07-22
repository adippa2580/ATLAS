import { Controller, Get, Injectable, Module, Query } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { SubjectType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

/**
 * Taste-segments — the targeting layer that lets a tenant shift spend from paid
 * acquisition (rising CAC) to OWNED, addressable audiences built from the taste
 * graph. Reachability here mirrors revenue-insights `identityCoverage`: a guest
 * only counts toward a segment if it is genuinely addressable — non-provisional
 * AND covered by an active (un-revoked) marketing/identity ConsentGrant. Muted
 * affinities never target (an explicit "don't market this to me"), and each
 * addressable guest is clustered into exactly ONE segment: its single strongest
 * non-muted affinity of the requested subjectType.
 *
 * GET /v1/audiences/taste-segments?subjectType=artist|genre&minScore=&limit=
 *
 * Money is not involved; scores are the derived, decay-aware GuestAffinity.score.
 */

/** Consent scopes that make a guest reachable for owned-audience marketing. */
export const REACHABLE_CONSENT_SCOPES = ['marketing', 'identity'];

/** How many example guests to surface per segment (the rest are counted only). */
export const SAMPLE_GUESTS_PER_SEGMENT = 5;

export interface TasteSegment {
  subjectType: SubjectType;
  subjectRef: string;
  segmentName: string;
  reachableGuests: number;
  sampleGuests: {
    guestId: string;
    displayName: string | null;
    score: number;
  }[];
  avgScore: number;
}

@Injectable()
export class TasteSegmentsService {
  constructor(private readonly prisma: PrismaService) {}

  async segments(
    ctx: TenantContext,
    opts: { subjectType?: SubjectType; minScore?: number; limit?: number } = {},
  ): Promise<{
    tenantId: string;
    subjectType: SubjectType;
    minScore: number;
    segmentCount: number;
    segments: TasteSegment[];
  }> {
    const t = ctx.tenantId;
    const subjectType = opts.subjectType ?? SubjectType.genre;
    const minScore = opts.minScore ?? 0;
    const limit = opts.limit ?? 100;

    // Addressable universe: non-provisional guests with an active (un-revoked)
    // marketing/identity consent. Anyone outside this set can never be reached,
    // so they must not inflate a segment's `reachableGuests`.
    const addressable = await this.prisma.guest.findMany({
      where: {
        tenantId: t,
        provisional: false,
        consents: {
          some: { revokedAt: null, scope: { in: REACHABLE_CONSENT_SCOPES } },
        },
      },
      select: { id: true, displayName: true },
    });
    const addressableName = new Map<string, string | null>();
    for (const g of addressable)
      addressableName.set(g.id, g.displayName ?? null);

    // Non-muted affinities of the requested subject type, at or above the score
    // floor, strongest first. Ordering score-desc means the FIRST row we see for
    // a guest is that guest's strongest subject of this type.
    const affinities = await this.prisma.guestAffinity.findMany({
      where: {
        tenantId: t,
        subjectType,
        muted: false,
        score: { gte: minScore },
      },
      orderBy: { score: 'desc' },
      select: { guestId: true, subjectRef: true, score: true },
    });

    // Cluster each addressable guest by its single strongest subject.
    type Member = {
      guestId: string;
      displayName: string | null;
      score: number;
    };
    const bySubject = new Map<string, Member[]>();
    const assigned = new Set<string>();
    for (const a of affinities) {
      if (!addressableName.has(a.guestId)) continue; // not reachable → skip
      if (assigned.has(a.guestId)) continue; // already placed in its top segment
      assigned.add(a.guestId);
      let members = bySubject.get(a.subjectRef);
      if (!members) {
        members = [];
        bySubject.set(a.subjectRef, members);
      }
      members.push({
        guestId: a.guestId,
        displayName: addressableName.get(a.guestId) ?? null,
        score: a.score,
      });
    }

    // Resolve artist subjectRefs to catalog names; genres are plain strings.
    const nameByRef = new Map<string, string>();
    if (subjectType === SubjectType.artist && bySubject.size > 0) {
      const refs = [...bySubject.keys()];
      const entities = await this.prisma.entity.findMany({
        where: { id: { in: refs } },
        select: { id: true, name: true },
      });
      for (const e of entities) nameByRef.set(e.id, e.name);
    }

    const segments: TasteSegment[] = [...bySubject.entries()]
      .map(([subjectRef, members]) => {
        const sorted = [...members].sort((a, b) => b.score - a.score);
        const total = sorted.reduce((s, m) => s + m.score, 0);
        const name =
          subjectType === SubjectType.artist
            ? (nameByRef.get(subjectRef) ?? subjectRef)
            : subjectRef;
        return {
          subjectType,
          subjectRef,
          segmentName: name,
          reachableGuests: sorted.length,
          sampleGuests: sorted.slice(0, SAMPLE_GUESTS_PER_SEGMENT),
          avgScore: sorted.length > 0 ? total / sorted.length : 0,
        };
      })
      // Biggest addressable reach first — the segments worth shifting spend to.
      .sort((a, b) => b.reachableGuests - a.reachableGuests)
      .slice(0, limit);

    return {
      tenantId: t,
      subjectType,
      minScore,
      segmentCount: segments.length,
      segments,
    };
  }
}

@ApiTags('mkt:audiences')
@Controller('audiences')
export class TasteSegmentsController {
  constructor(private readonly svc: TasteSegmentsService) {}

  /** Addressable taste-segments, largest reach first. */
  @Get('taste-segments')
  @Scopes('mkt:audiences:read')
  tasteSegments(
    @Tenant() ctx: TenantContext,
    @Query('subjectType') subjectType?: string,
    @Query('minScore') minScore?: string,
    @Query('limit') limit?: string,
  ) {
    return this.svc.segments(ctx, {
      subjectType: parseSubjectType(subjectType),
      minScore: parseNum(minScore, 0, 0),
      limit: parseNum(limit, 100, 1, 1000),
    });
  }
}

/** Only artist|genre are valid targeting subjects here; anything else → genre. */
function parseSubjectType(raw?: string): SubjectType {
  if (raw === SubjectType.artist) return SubjectType.artist;
  return SubjectType.genre;
}

/** Parse a query number, clamped to [min, max?], falling back to `fallback`. */
function parseNum(
  raw: string | undefined,
  fallback: number,
  min: number,
  max?: number,
): number {
  const n = raw === undefined ? NaN : Number(raw);
  if (Number.isNaN(n)) return fallback;
  const lo = Math.max(min, n);
  return max === undefined ? lo : Math.min(max, lo);
}

@Module({
  controllers: [TasteSegmentsController],
  providers: [TasteSegmentsService],
  exports: [TasteSegmentsService],
})
export class TasteSegmentsModule {}
