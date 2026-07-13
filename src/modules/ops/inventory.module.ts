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
import { IsEnum, IsNumber, IsOptional, IsString } from 'class-validator';
import { InventoryKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

class CreateVenueDto {
  @IsString() name!: string;
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() floorMapRef?: string;
}

class UpsertInventoryDto {
  @IsOptional() @IsString() venueId?: string;
  @IsOptional() @IsEnum(InventoryKind) kind?: InventoryKind;
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsNumber() capacity?: number;
  @IsOptional() @IsNumber() minSpend?: number;
  @IsOptional() @IsNumber() deposit?: number;
}

/**
 * Inventory & Floor Map (#10) — tables, tickets, capacity, min-spend, and floor
 * geometry. The `POST /venues` and `POST /venues/:id/inventory` helpers exist so
 * a tenant can stand up test data without a seed script.
 */
@Injectable()
export class InventoryService {
  constructor(private readonly prisma: PrismaService) {}

  createVenue(ctx: TenantContext, dto: CreateVenueDto) {
    return this.prisma.venue.create({
      data: {
        tenantId: ctx.tenantId,
        name: dto.name,
        city: dto.city,
        floorMapRef: dto.floorMapRef,
      },
    });
  }

  async createInventory(
    ctx: TenantContext,
    venueId: string,
    dto: UpsertInventoryDto,
  ) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, tenantId: ctx.tenantId },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return this.prisma.inventory.create({
      data: {
        tenantId: ctx.tenantId,
        venueId,
        kind: dto.kind ?? InventoryKind.table,
        label: dto.label,
        capacity: dto.capacity ?? 1,
        minSpend: dto.minSpend,
        deposit: dto.deposit,
      },
    });
  }

  listInventory(ctx: TenantContext, venueId: string) {
    return this.prisma.inventory.findMany({
      where: { tenantId: ctx.tenantId, venueId },
    });
  }

  async floormap(ctx: TenantContext, venueId: string) {
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, tenantId: ctx.tenantId },
    });
    if (!venue) throw new NotFoundException('Venue not found');
    return { venueId, floorMapRef: venue.floorMapRef };
  }

  /** Upsert an inventory item, tenant-scoped. */
  async upsert(ctx: TenantContext, id: string, dto: UpsertInventoryDto) {
    const existing = await this.prisma.inventory.findFirst({
      where: { id, tenantId: ctx.tenantId },
    });
    if (existing) {
      return this.prisma.inventory.update({
        where: { id },
        data: {
          kind: dto.kind ?? existing.kind,
          label: dto.label,
          capacity: dto.capacity ?? existing.capacity,
          minSpend: dto.minSpend,
          deposit: dto.deposit,
        },
      });
    }
    if (!dto.venueId) {
      throw new NotFoundException(
        'Inventory not found (venueId required to create)',
      );
    }
    return this.prisma.inventory.create({
      data: {
        id,
        tenantId: ctx.tenantId,
        venueId: dto.venueId,
        kind: dto.kind ?? InventoryKind.table,
        label: dto.label,
        capacity: dto.capacity ?? 1,
        minSpend: dto.minSpend,
        deposit: dto.deposit,
      },
    });
  }
}

@ApiTags('ops:inventory')
@Controller('venues')
export class VenueInventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Post()
  @Scopes('ops:inventory:write')
  createVenue(@Tenant() ctx: TenantContext, @Body() dto: CreateVenueDto) {
    return this.svc.createVenue(ctx, dto);
  }

  @Get(':id/inventory')
  @Scopes('ops:inventory:read')
  listInventory(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.listInventory(ctx, id);
  }

  @Post(':id/inventory')
  @Scopes('ops:inventory:write')
  createInventory(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpsertInventoryDto,
  ) {
    return this.svc.createInventory(ctx, id, dto);
  }

  @Get(':id/floormap')
  @Scopes('ops:inventory:read')
  floormap(@Tenant() ctx: TenantContext, @Param('id') id: string) {
    return this.svc.floormap(ctx, id);
  }
}

@ApiTags('ops:inventory')
@Controller('inventory')
export class InventoryController {
  constructor(private readonly svc: InventoryService) {}

  @Put(':id')
  @Scopes('ops:inventory:write')
  upsert(
    @Tenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpsertInventoryDto,
  ) {
    return this.svc.upsert(ctx, id, dto);
  }
}

@Module({
  controllers: [VenueInventoryController, InventoryController],
  providers: [InventoryService],
  exports: [InventoryService],
})
export class InventoryModule {}
