import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { IdentityLinkKind, SubjectType } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { sha256 } from '../../../common/util/hash';
import { IdentityService } from '../identity/identity.service';
import { IdentityModule } from '../identity/identity.module';

/**
 * Streamlined add-a-member. A crew is grown one person at a time from the floor:
 * a name, a phone, an email — whatever the host has. Rather than force the caller
 * to pre-resolve a guestId (the current PUT /members contract), this accepts loose
 * contact and resolves-or-creates the guest, mirroring the door walk-in path.
 */
class AddMemberDto {
  /** Resolve directly when the caller already holds the guest id. */
  @IsOptional() @IsString() guestId?: string;

  /** E.164 phone — resolved via identity link, then direct match. */
  @IsOptional() @IsString() phone?: string;

  @IsOptional() @IsString() email?: string;

  /** Name to seed a provisional guest when nothing resolves. */
  @IsOptional() @IsString() displayName?: string;
}

export interface AddMemberResult {
  crewId: string;
  guestId: string;
  added: boolean;
  alreadyMember: boolean;
}

export interface GroupOfferSubject {
  subjectType: SubjectType;
  subjectRef: string;
  blendedScore: number;
}

export interface GroupOffer {
  crewId: string;
  memberCount: number;
  topSubjects: GroupOfferSubject[];
  template: {
    headline: string;
    body: string;
    /**
     * How the table minimum splits across the crew. We never invent money: when
     * no minimum spend is known this is a size-based fraction (1/N of the table),
     * not a cents figure.
     */
    perHeadFraming: string;
  };
}

/**
 * Crew engagement levers: streamline add-a-member and templatize the group
 * offer. Both are tenant-scoped and read the same Crew / CrewMember / CrewAffinity
 * graph the blend worker maintains — this module only reads the blend, never
 * recomputes it.
 */
@Injectable()
export class CrewEngageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly identity: IdentityService,
  ) {}

  /**
   * Add one guest to a crew from loose contact. Resolves an existing guest
   * (by id, then verified identity link, then direct phone/email) or creates a
   * provisional one, then upserts the CrewMember. Idempotent: re-adding an
   * existing member is a safe no-op (added:false, alreadyMember:true) with no
   * duplicate row.
   */
  async addMember(
    ctx: TenantContext,
    crewId: string,
    dto: AddMemberDto,
  ): Promise<AddMemberResult> {
    const t = ctx.tenantId;
    await this.assertCrewInTenant(ctx, crewId);

    const phone = dto.phone?.trim() || undefined;
    const email = dto.email?.trim() || undefined;

    // 1. Resolve an existing guest. Mirror the door walk-in resolve order:
    //    explicit id → verified identity link → direct phone/email match.
    let guest = null as Awaited<
      ReturnType<PrismaService['guest']['findFirst']>
    >;
    if (dto.guestId) {
      guest = await this.prisma.guest.findFirst({
        where: { id: dto.guestId, tenantId: t },
      });
      if (!guest) throw new NotFoundException('Guest not found for tenant');
    }
    if (!guest && (phone || email)) {
      const pairs = [
        ...(phone
          ? [{ kind: IdentityLinkKind.phone, valueHash: sha256(phone) }]
          : []),
        ...(email
          ? [{ kind: IdentityLinkKind.email, valueHash: sha256(email) }]
          : []),
      ];
      const link = await this.prisma.identityLink.findFirst({
        where: { tenantId: t, OR: pairs },
      });
      if (link) {
        guest = await this.prisma.guest.findFirst({
          where: { id: link.guestId, tenantId: t },
        });
      }
      if (!guest) {
        guest = await this.prisma.guest.findFirst({
          where: {
            tenantId: t,
            OR: [
              ...(phone ? [{ primaryPhone: phone }] : []),
              ...(email ? [{ email }] : []),
            ],
          },
        });
      }
    }

    // 2. Nothing resolved — mint a provisional guest so the crew still grows.
    if (!guest) {
      guest = await this.identity.create(ctx, {
        primaryPhone: phone,
        email,
        displayName: dto.displayName,
        provisional: true,
      });
    }
    const guestId = guest!.id;

    // 3. Upsert the membership. CrewMember's PK is (crewId, guestId), so an
    //    existing member is a no-op — never a duplicate.
    const existing = await this.prisma.crewMember.findUnique({
      where: { crewId_guestId: { crewId, guestId } },
    });
    if (existing) {
      return { crewId, guestId, added: false, alreadyMember: true };
    }

    await this.prisma.crewMember.create({
      data: { tenantId: t, crewId, guestId, role: 'member' },
    });
    return { crewId, guestId, added: true, alreadyMember: false };
  }

  /**
   * Templatize the crew's group offer. Reads the blended CrewAffinity (top
   * subjects) and member count and produces a ready-to-send offer template. Money
   * is never invented: per-head framing is expressed as a fraction of the table
   * minimum (1/N), which the caller can multiply by a real minSpend at send time.
   */
  async groupOffer(ctx: TenantContext, crewId: string): Promise<GroupOffer> {
    const t = ctx.tenantId;
    const crew = await this.assertCrewInTenant(ctx, crewId);

    const [memberCount, affinities] = await Promise.all([
      this.prisma.crewMember.count({ where: { tenantId: t, crewId } }),
      this.prisma.crewAffinity.findMany({
        where: { tenantId: t, crewId },
        orderBy: { blendedScore: 'desc' },
        take: 3,
      }),
    ]);

    const topSubjects: GroupOfferSubject[] = affinities.map((a) => ({
      subjectType: a.subjectType,
      subjectRef: a.subjectRef,
      blendedScore: a.blendedScore,
    }));

    const crewLabel = crew.name?.trim() || 'your crew';
    const headline =
      topSubjects.length > 0
        ? `A table for ${crewLabel} — built around ${topSubjects[0].subjectRef}`
        : `A table for ${crewLabel}`;

    const tasteList = topSubjects.map((s) => s.subjectRef).join(', ');
    const body =
      topSubjects.length > 0
        ? `Based on what ${crewLabel} love${
            memberCount === 1 ? 's' : ''
          } — ${tasteList} — we've held a table for the ${memberCount} of you. Reserve as a group and split the minimum.`
        : `We've held a table for the ${memberCount} of you. Reserve as a group and split the minimum.`;

    // Size-based per-head framing. No minSpend is available on the crew, so we
    // express each head's share as a fraction of the table minimum rather than a
    // fabricated cents amount.
    const perHeadFraming =
      memberCount > 0
        ? `Split evenly, each of the ${memberCount} covers 1/${memberCount} of the table minimum`
        : 'Add members to split the table minimum';

    return {
      crewId,
      memberCount,
      topSubjects,
      template: { headline, body, perHeadFraming },
    };
  }

  private async assertCrewInTenant(ctx: TenantContext, crewId: string) {
    const crew = await this.prisma.crew.findUnique({ where: { id: crewId } });
    if (!crew || crew.tenantId !== ctx.tenantId) {
      throw new NotFoundException('Crew not found for tenant');
    }
    return crew;
  }
}

@ApiTags('guest:crew')
@Controller('crews')
export class CrewEngageController {
  constructor(private readonly svc: CrewEngageService) {}

  /** Streamlined add-a-member: resolve-or-create then attach, idempotently. */
  @Post(':id/members:add')
  @Scopes('guest:crew:write')
  addMember(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.svc.addMember(ctx, id, dto);
  }

  /** Templatized group offer from the crew's blend + size. Read-only. */
  @Get(':id/group-offer')
  @Scopes('guest:crew:read')
  groupOffer(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.groupOffer(ctx, id);
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [CrewEngageController],
  providers: [CrewEngageService],
  exports: [CrewEngageService],
})
export class CrewEngageModule {}
