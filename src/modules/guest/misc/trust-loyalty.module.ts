import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsNumber, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { EvidenceBus } from '../../../common/evidence/evidence-bus';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { sha256 } from '../../../common/util/hash';

class TrustEventDto {
  @IsString() guestId!: string;
  @IsString() kind!: string; // no_show | positive | ...
  @IsOptional() @IsNumber() weight?: number;
}
class AccrueLoyaltyDto {
  @IsString() guestId!: string;
  @IsOptional() @IsString() reason?: string;
}

@Injectable()
export class TrustService {
  constructor(private readonly prisma: PrismaService) {}

  async score(ctx: TenantContext, guestId: string) {
    const events = await this.prisma.trustEvent.findMany({
      where: { tenantId: ctx.tenantId, guestId },
    });
    const score = events.reduce(
      (s, e) => s + (e.kind === 'no_show' ? -e.weight : e.weight),
      1,
    );
    return { guestId, score, factors: events.length };
  }

  record(ctx: TenantContext, dto: TrustEventDto) {
    return this.prisma.trustEvent.create({
      data: {
        tenantId: ctx.tenantId,
        guestId: dto.guestId,
        kind: dto.kind,
        weight: dto.weight ?? 1,
      },
    });
  }
}

@Injectable()
export class LoyaltyService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  async standing(ctx: TenantContext, guestId: string) {
    const credits = await this.prisma.entitlement.count({
      where: { tenantId: ctx.tenantId, guestId, kind: 'loyalty_credit' },
    });
    return { guestId, loyaltyCredits: credits };
  }

  async accrue(ctx: TenantContext, dto: AccrueLoyaltyDto) {
    const ent = await this.prisma.entitlement.create({
      data: {
        tenantId: ctx.tenantId,
        guestId: dto.guestId,
        kind: 'loyalty_credit',
      },
    });
    // Loyalty is revealed preference — write it as evidence.
    await this.bus.publish({
      tenantId: ctx.tenantId,
      guestId: dto.guestId,
      subjectType: 'venue' as any,
      subjectRef: ctx.tenantId,
      signal: 'loyalty' as any,
      weight: 1,
      provenance: 'booking' as any,
      dedupeKey: sha256('loyalty', ent.id),
      observedAt: new Date().toISOString(),
    });
    return ent;
  }
}

@ApiTags('guest:trust-loyalty')
@Controller()
export class TrustLoyaltyController {
  constructor(
    private readonly trust: TrustService,
    private readonly loyalty: LoyaltyService,
  ) {}

  @Get('guests/:id/trust')
  @Scopes('guest:trust:read')
  trustScore(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.trust.score(ctx, id);
  }

  @Post('trust/events')
  @Scopes('guest:trust:write')
  trustEvent(@Tenant() ctx: TenantContext, @Body() dto: TrustEventDto) {
    return this.trust.record(ctx, dto);
  }

  @Get('guests/:id/loyalty')
  @Scopes('guest:loyalty:read')
  loyaltyStanding(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.loyalty.standing(ctx, id);
  }

  @Post('loyalty/accrue')
  @Scopes('guest:loyalty:write')
  accrue(@Tenant() ctx: TenantContext, @Body() dto: AccrueLoyaltyDto) {
    return this.loyalty.accrue(ctx, dto);
  }
}

@Module({
  controllers: [TrustLoyaltyController],
  providers: [TrustService, LoyaltyService],
  exports: [TrustService, LoyaltyService],
})
export class TrustLoyaltyModule {}
