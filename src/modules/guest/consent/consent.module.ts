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

class CreateConsentDto {
  @IsString() guestId!: string;
  @IsString() scope!: string;
  @IsEnum(ConsentBasis) basis!: ConsentBasis;
  @IsOptional() @IsString() connector?: string;
}

@Injectable()
export class ConsentService {
  constructor(private readonly prisma: PrismaService) {}

  create(ctx: TenantContext, dto: CreateConsentDto) {
    return this.prisma.consentGrant.create({
      data: { tenantId: ctx.tenantId, ...dto },
    });
  }

  revoke(ctx: TenantContext, id: string) {
    return this.prisma.consentGrant.updateMany({
      where: { id, tenantId: ctx.tenantId },
      data: { revokedAt: new Date() },
    });
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
  providers: [ConsentService],
  exports: [ConsentService],
})
export class ConsentModule {}
