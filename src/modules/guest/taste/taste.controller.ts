import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TasteService } from './taste.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { AppendEvidenceDto, MuteDto } from './dto';

@ApiTags('guest:taste')
@Controller()
export class TasteController {
  constructor(private readonly taste: TasteService) {}

  // The single graph-write endpoint (primitive #4).
  @Post('evidence')
  @Scopes('guest:evidence:write')
  append(@Tenant() ctx: TenantContext, @Body() dto: AppendEvidenceDto) {
    return this.taste.appendEvidence(ctx, dto);
  }

  @Get('guests/:id/affinity')
  @Scopes('guest:affinity:read')
  affinity(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.taste.getAffinity(ctx, id);
  }

  // The raw append-only evidence log — the actual writes into the graph.
  @Get('guests/:id/evidence')
  @Scopes('guest:affinity:read')
  evidence(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.taste.listEvidence(ctx, id);
  }

  @Post('guests/:id/mutes')
  @Scopes('guest:affinity:write')
  mute(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: MuteDto,
  ) {
    return this.taste.mute(ctx, id, dto);
  }
}
