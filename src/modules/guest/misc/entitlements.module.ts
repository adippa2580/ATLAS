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
import { IsEnum, IsOptional, IsString } from 'class-validator';
import { EntitlementKind } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class GrantEntitlementDto {
  @IsString() guestId!: string;
  @IsEnum(EntitlementKind) kind!: EntitlementKind;
  @IsOptional() @IsString() expiresAt?: string;
}

@Injectable()
export class EntitlementsService {
  constructor(private readonly prisma: PrismaService) {}

  list(ctx: TenantContext, guestId: string) {
    return this.prisma.entitlement.findMany({
      where: { tenantId: ctx.tenantId, guestId },
    });
  }

  grant(ctx: TenantContext, dto: GrantEntitlementDto) {
    return this.prisma.entitlement.create({
      data: {
        tenantId: ctx.tenantId,
        guestId: dto.guestId,
        kind: dto.kind,
        expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : undefined,
      },
    });
  }

  redeem(ctx: TenantContext, id: string) {
    return this.prisma.entitlement.updateMany({
      where: { id, tenantId: ctx.tenantId },
      data: { state: 'redeemed' },
    });
  }
}

@ApiTags('guest:entitlements')
@Controller()
export class EntitlementsController {
  constructor(private readonly svc: EntitlementsService) {}

  @Get('guests/:id/entitlements')
  @Scopes('guest:entitlements:read')
  list(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.list(ctx, id);
  }

  @Post('entitlements')
  @Scopes('guest:entitlements:write')
  grant(@Tenant() ctx: TenantContext, @Body() dto: GrantEntitlementDto) {
    return this.svc.grant(ctx, dto);
  }

  @Post('entitlements/:id/redeem')
  @Scopes('guest:entitlements:write')
  redeem(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.redeem(ctx, id);
  }
}

@Module({
  controllers: [EntitlementsController],
  providers: [EntitlementsService],
  exports: [EntitlementsService],
})
export class EntitlementsModule {}
