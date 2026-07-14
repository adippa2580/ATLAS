import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { CrewBlendService } from './crew-blend.service';

class CreateCrewDto {
  @IsString() ownerGuestId!: string;
  @IsOptional() @IsString() name?: string;
}
class SetMembersDto {
  @IsArray() @IsString({ each: true }) guestIds!: string[];
}

@Injectable()
export class CrewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly blend: CrewBlendService,
  ) {}

  async create(ctx: TenantContext, dto: CreateCrewDto) {
    const crew = await this.prisma.crew.create({
      data: {
        tenantId: ctx.tenantId,
        name: dto.name,
        ownerGuestId: dto.ownerGuestId,
        // CrewMember is tenant-scoped (P0-2) — carry the crew's tenant.
        members: {
          create: {
            tenantId: ctx.tenantId,
            guestId: dto.ownerGuestId,
            role: 'owner',
          },
        },
      },
      include: { members: true },
    });
    await this.blend.recompute(ctx, crew.id);
    return crew;
  }

  async setMembers(ctx: TenantContext, crewId: string, dto: SetMembersDto) {
    // Only mutate a crew that belongs to the caller's tenant.
    await this.assertCrewInTenant(ctx, crewId);
    await this.prisma.crewMember.deleteMany({
      where: { tenantId: ctx.tenantId, crewId },
    });
    await this.prisma.crewMember.createMany({
      data: dto.guestIds.map((guestId) => ({
        tenantId: ctx.tenantId,
        crewId,
        guestId,
      })),
      skipDuplicates: true,
    });
    // Crew is an input, not an invite — changing it re-runs the blend.
    await this.blend.recompute(ctx, crewId);
    return this.prisma.crew.findFirst({
      where: { id: crewId, tenantId: ctx.tenantId },
      include: { members: true },
    });
  }

  async getAffinity(ctx: TenantContext, crewId: string) {
    await this.assertCrewInTenant(ctx, crewId);
    return this.prisma.crewAffinity.findMany({
      where: { tenantId: ctx.tenantId, crewId },
      orderBy: { blendedScore: 'desc' },
    });
  }

  private async assertCrewInTenant(ctx: TenantContext, crewId: string) {
    const crew = await this.prisma.crew.findUnique({ where: { id: crewId } });
    if (!crew || crew.tenantId !== ctx.tenantId) {
      throw new NotFoundException('Crew not found for tenant');
    }
  }
}

@ApiTags('guest:crew')
@Controller('crews')
export class CrewController {
  constructor(private readonly crew: CrewService) {}

  @Post()
  @Scopes('guest:crew:write')
  create(@Tenant() ctx: TenantContext, @Body() dto: CreateCrewDto) {
    return this.crew.create(ctx, dto);
  }

  @Put(':id/members')
  @Scopes('guest:crew:write')
  setMembers(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SetMembersDto,
  ) {
    return this.crew.setMembers(ctx, id, dto);
  }

  @Get(':id/affinity')
  @Scopes('guest:crew:read')
  affinity(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.crew.getAffinity(ctx, id);
  }
}

@Module({
  controllers: [CrewController],
  providers: [CrewService, CrewBlendService],
  exports: [CrewService, CrewBlendService],
})
export class CrewModule {}
