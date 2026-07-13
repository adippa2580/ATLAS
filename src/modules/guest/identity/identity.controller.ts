import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IdentityService } from './identity.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { AddLinkDto, CreateGuestDto, MergeDto } from './dto';

@ApiTags('guest:identity')
@Controller('guests')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  @Post()
  @Scopes('guest:identity:write')
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateGuestDto) {
    return this.identity.create(ctx, dto);
  }

  @Get(':id')
  @Scopes('guest:identity:read')
  get(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.identity.get(ctx, id);
  }

  @Post(':id/links')
  @Scopes('guest:identity:write')
  addLink(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: AddLinkDto,
  ) {
    return this.identity.addLink(ctx, id, dto);
  }

  @Post(':id/merge')
  @Scopes('guest:identity:merge')
  merge(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: MergeDto,
  ) {
    return this.identity.merge(ctx, { ...dto, survivingId: id });
  }
}
