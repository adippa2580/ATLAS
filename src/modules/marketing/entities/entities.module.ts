import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Param,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { EntityKind } from '@prisma/client';
import { IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';

class UpsertEntityDto {
  @IsEnum(EntityKind) kind!: EntityKind;
  @IsString() name!: string;
  @IsOptional() @IsObject() externalRefs?: Record<string, any>;
  @IsOptional() @IsObject() metadata?: Record<string, any>;
}

@Injectable()
export class EntitiesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Cold-start catalog: artists, events, venues. NOT tenant-scoped — this is the
   * shared, non-personal catalog (the only place scraped/purchased data lives).
   */
  search(kind?: EntityKind, q?: string) {
    return this.prisma.entity.findMany({
      where: {
        ...(kind ? { kind } : {}),
        ...(q ? { name: { contains: q, mode: 'insensitive' } } : {}),
      },
      take: 50,
    });
  }

  upsert(id: string, dto: UpsertEntityDto) {
    return this.prisma.entity.upsert({
      where: { id },
      create: {
        id,
        kind: dto.kind,
        name: dto.name,
        externalRefs: dto.externalRefs as any,
        metadata: dto.metadata as any,
      },
      update: {
        kind: dto.kind,
        name: dto.name,
        externalRefs: dto.externalRefs as any,
        metadata: dto.metadata as any,
      },
    });
  }
}

@ApiTags('mkt:entities')
@Controller()
export class EntitiesController {
  constructor(private readonly svc: EntitiesService) {}

  // Entity is a shared catalog — deliberately not filtered by tenantId.
  @Get('entities')
  @Scopes('mkt:entities:read')
  search(
    @Tenant() _ctx: TenantContext,
    @Query('kind') kind?: EntityKind,
    @Query('q') q?: string,
  ) {
    return this.svc.search(kind, q);
  }

  @Put('entities/:id')
  @Scopes('mkt:entities:write')
  upsert(
    @Tenant() _ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpsertEntityDto,
  ) {
    return this.svc.upsert(id, dto);
  }
}

@Module({
  controllers: [EntitiesController],
  providers: [EntitiesService],
  exports: [EntitiesService],
})
export class EntitiesModule {}
