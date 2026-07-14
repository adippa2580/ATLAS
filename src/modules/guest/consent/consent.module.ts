import {
  Body,
  Controller,
  Delete,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { ConsentBasis } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { AffinityRecomputeService } from '../taste/affinity-recompute.service';
import { TasteModule } from '../taste/taste.module';

class CreateConsentDto {
  @IsString() guestId!: string;
  @IsString() scope!: string;
  @IsEnum(ConsentBasis) basis!: ConsentBasis;
  @IsOptional() @IsString() connector?: string;
}

@Injectable()
export class ConsentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly recompute: AffinityRecomputeService,
  ) {}

  create(ctx: TenantContext, dto: CreateConsentDto) {
    return this.prisma.consentGrant.create({
      data: { tenantId: ctx.tenantId, ...dto },
    });
  }

  async revoke(ctx: TenantContext, id: string) {
    const result = await this.prisma.consentGrant.updateMany({
      where: { id, tenantId: ctx.tenantId },
      data: { revokedAt: new Date() },
    });

    // Purge derived taste that this consent gated (P0-8). Find the distinct
    // subjects this consent contributed evidence for and recompute each — the
    // fold now excludes the just-revoked consent, so its contribution drops out.
    const subjects = await this.prisma.affinityEvidence.findMany({
      where: { tenantId: ctx.tenantId, consentId: id },
      select: { guestId: true, subjectType: true, subjectRef: true },
      distinct: ['guestId', 'subjectType', 'subjectRef'],
    });
    for (const s of subjects) {
      await this.recompute.recomputeSubject(
        ctx.tenantId,
        s.guestId,
        s.subjectType,
        s.subjectRef,
      );
    }

    return result;
  }

  listForGuest(ctx: TenantContext, guestId: string) {
    return this.prisma.consentGrant.findMany({
      where: { tenantId: ctx.tenantId, guestId, revokedAt: null },
    });
  }
}

@ApiTags('guest:consent')
@Controller()
export class ConsentController {
  constructor(private readonly consent: ConsentService) {}

  @Post('consent')
  @Scopes('guest:consent:write')
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateConsentDto) {
    return this.consent.create(ctx, dto);
  }

  @Delete('consent/:id')
  @Scopes('guest:consent:write')
  revoke(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.consent.revoke(ctx, id);
  }

  @Get('guests/:id/consent')
  @Scopes('guest:consent:read')
  list(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.consent.listForGuest(ctx, id);
  }
}

@Module({
  controllers: [ConsentController],
  // Import TasteModule to reuse its single AffinityRecomputeService instance —
  // avoids a second EvidenceBus subscription (which would recompute every event
  // twice). The service is exported by TasteModule.
  imports: [TasteModule],
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
