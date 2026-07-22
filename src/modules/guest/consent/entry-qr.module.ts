import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { randomUUID } from 'crypto';
import {
  ConsentBasis,
  IdentityLinkKind,
  Provenance,
  Signal,
  SubjectType,
} from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EvidenceBus } from '../../../common/evidence/evidence-bus';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { evidenceDedupeKey, sha256 } from '../../../common/util/hash';
import { IdentityService } from '../identity/identity.service';
import { IdentityModule } from '../identity/identity.module';

/**
 * A guest scanning a venue's entry-QR at door check-in and opting in. This is
 * the walk-in capture pattern generalised to every venue: the scan IS the
 * opt-in, so a resolved-or-created guest is non-provisional from the start,
 * their contact is persisted as VERIFIED identity links, and the opt-in lands
 * as an explicit consent grant that gates (and tags) the enrichment evidence.
 */
class EntryQrDto {
  @IsString() venueId!: string;

  /** E.164 phone captured by the scan/form. */
  @IsOptional() @IsString() phone?: string;

  @IsOptional() @IsString() email?: string;

  @IsOptional() @IsString() displayName?: string;

  /** Consent scope granted by the scan; defaults to 'identity'. */
  @IsOptional() @IsString() scope?: string;

  /** Known guest id, e.g. when the QR is personalised to a wallet holder. */
  @IsOptional() @IsString() guestId?: string;
}

@Injectable()
export class EntryQrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
    private readonly identity: IdentityService,
  ) {}

  /**
   * Capture an entry-QR opt-in: resolve or create the guest, persist verified
   * identity links, record the consent grant, and publish a consent-tagged
   * venue `attend` signal. Idempotent per (venue, contact, day): a repeat scan
   * on the same day returns the same guest + consent without duplicating links,
   * consent grants or evidence.
   */
  async scan(ctx: TenantContext, dto: EntryQrDto) {
    const t = ctx.tenantId;
    const phone = dto.phone?.trim() || undefined;
    const email = dto.email?.trim() || undefined;
    const scope = dto.scope?.trim() || 'identity';
    const contact = phone ?? email;

    // Idempotency anchor: the day-scoped evidence dedupe key. A repeat scan on
    // the same (venue, contact, day) resolves the same evidence row, so we
    // short-circuit rather than re-writing links / consent / evidence.
    const day = new Date().toISOString().slice(0, 10);
    const dedupeKey = contact
      ? evidenceDedupeKey(
          'entry-qr',
          `${dto.venueId}:${contact}:${day}`,
          'attend',
        )
      : evidenceDedupeKey(
          'entry-qr',
          `${dto.venueId}:${randomUUID()}`,
          'attend',
        );

    if (contact) {
      const prior = await this.prisma.affinityEvidence.findUnique({
        where: { tenantId_dedupeKey: { tenantId: t, dedupeKey } },
      });
      if (prior) {
        const guest = await this.prisma.guest.findFirst({
          where: { id: prior.guestId, tenantId: t },
        });
        return {
          guest,
          consentId: prior.consentId ?? undefined,
          linksAdded: 0,
        };
      }
    }

    // 1. Resolve an existing guest — explicit guestId, then a verified/any
    //    identity link on phone/email, then a direct primaryPhone/email match.
    let guest = null as Awaited<
      ReturnType<PrismaService['guest']['findFirst']>
    >;
    if (dto.guestId) {
      guest = await this.prisma.guest.findFirst({
        where: { id: dto.guestId, tenantId: t },
      });
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
        orderBy: { verified: 'desc' },
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

    // 2. Create the guest — non-provisional, because the scan is itself the
    //    opt-in — or promote an existing provisional record.
    if (!guest) {
      guest = await this.identity.create(ctx, {
        primaryPhone: phone,
        email,
        displayName: dto.displayName,
        provisional: false,
      });
    } else if (guest.provisional) {
      guest = await this.prisma.guest.update({
        where: { id: guest.id },
        data: {
          provisional: false,
          primaryPhone: guest.primaryPhone ?? phone ?? null,
          email: guest.email ?? email ?? null,
          displayName: guest.displayName ?? dto.displayName ?? null,
        },
      });
    }
    const guestId = guest!.id;

    // 3. Persist VERIFIED identity links (the opt-in verifies the contact and
    //    anchors the cross-tenant spine via IdentityService.addLink).
    let linksAdded = 0;
    if (phone) {
      await this.identity.addLink(ctx, guestId, {
        kind: IdentityLinkKind.phone,
        value: phone,
        verified: true,
        source: 'entry-qr',
      });
      linksAdded++;
    }
    if (email) {
      await this.identity.addLink(ctx, guestId, {
        kind: IdentityLinkKind.email,
        value: email,
        verified: true,
        source: 'entry-qr',
      });
      linksAdded++;
    }

    // 4. Record the opt-in as an explicit consent grant.
    const grant = await this.prisma.consentGrant.create({
      data: {
        tenantId: t,
        guestId,
        scope,
        basis: ConsentBasis.explicit,
        connector: 'entry-qr',
      },
    });
    const consentId = grant.id;

    // 5. Publish the arrival as a consent-tagged venue `attend` signal.
    await this.bus.publish({
      tenantId: t,
      guestId,
      subjectType: SubjectType.venue,
      subjectRef: dto.venueId,
      signal: Signal.attend,
      weight: 2,
      provenance: Provenance.venue_link,
      consentId,
      dedupeKey,
      observedAt: new Date().toISOString(),
    });

    return { guest, consentId, linksAdded };
  }
}

@ApiTags('guest:consent')
@Controller('consent')
export class EntryQrController {
  constructor(private readonly svc: EntryQrService) {}

  @Post('entry-qr')
  @Scopes('guest:consent:write')
  entryQr(@Tenant() ctx: TenantContext, @Body() dto: EntryQrDto) {
    return this.svc.scan(ctx, dto);
  }
}

@Module({
  imports: [IdentityModule],
  controllers: [EntryQrController],
  providers: [EntryQrService],
  exports: [EntryQrService],
})
export class EntryQrModule {}
