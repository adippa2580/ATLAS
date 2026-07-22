import {
  Body,
  Controller,
  Injectable,
  Module,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';
import { InventoryKind } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';

/** Default number of after-party slots dropped when the caller omits `count`. */
export const DEFAULT_DROP_COUNT = 4;
/** Default label prefix; individual rows become "Late Drop 1", "Late Drop 2"… */
export const DEFAULT_DROP_LABEL = 'Late Drop';
/** Sensible late-night after-party defaults (integer cents / seats). */
export const DEFAULT_MIN_SPEND = 150_000; // $1,500
export const DEFAULT_DEPOSIT = 25_000; // $250
export const DEFAULT_CAPACITY = 6;

class LateNightDropDto {
  @IsString() venueId!: string;
  /** Label prefix for the batch. Rows are numbered "{label} {n}". */
  @IsOptional() @IsString() label?: string;
  @IsOptional() @IsInt() @Min(1) @Max(100) count?: number;
  // Money is integer minor units (cents).
  @IsOptional() @IsInt() @Min(0) minSpend?: number;
  @IsOptional() @IsInt() @Min(0) deposit?: number;
  @IsOptional() @IsInt() @Min(1) capacity?: number;
}

export interface CreatedDropSlot {
  id: string;
  label: string;
  minSpend: number;
  deposit: number;
  capacity: number;
}

export interface LateNightDropResult {
  tenantId: string;
  venueId: string;
  created: CreatedDropSlot[];
  skippedExisting: number;
}

/**
 * Release late-night after-party inventory (yield lever). Converts
 * festival / late-night demand into weekend fill by dropping a batch of
 * late-night "after-party" table slots for a venue.
 *
 * Each drop is a normal Inventory row (kind `table`) labelled "Late Drop {n}"
 * so it's identifiable as part of a late-night release.
 *
 * Idempotent: Inventory has no idempotencyKey, so re-running the same drop for
 * the same (tenantId, venueId, label) is guarded by existence — an already
 * present label is skipped rather than duplicated. All reads/writes are scoped
 * to the caller's tenant, and the venue is validated to belong to the tenant.
 */
@Injectable()
export class InventoryDropService {
  constructor(private readonly prisma: PrismaService) {}

  async lateNightDrop(
    ctx: TenantContext,
    dto: LateNightDropDto,
  ): Promise<LateNightDropResult> {
    const tenantId = ctx.tenantId;
    const { venueId } = dto;

    // Validate the venue belongs to this tenant before creating anything.
    const venue = await this.prisma.venue.findFirst({
      where: { id: venueId, tenantId },
    });
    if (!venue) throw new NotFoundException('Venue not found');

    const prefix =
      (dto.label ?? DEFAULT_DROP_LABEL).trim() || DEFAULT_DROP_LABEL;
    const count = dto.count ?? DEFAULT_DROP_COUNT;
    const minSpend = dto.minSpend ?? DEFAULT_MIN_SPEND;
    const deposit = dto.deposit ?? DEFAULT_DEPOSIT;
    const capacity = dto.capacity ?? DEFAULT_CAPACITY;

    const labels = Array.from(
      { length: count },
      (_, i) => `${prefix} ${i + 1}`,
    );

    // Find which of the batch labels already exist for this venue/tenant so a
    // re-run is idempotent and doesn't duplicate rows.
    const existing = await this.prisma.inventory.findMany({
      where: { tenantId, venueId, label: { in: labels } },
      select: { label: true },
    });
    const existingLabels = new Set(
      existing.map((e) => e.label).filter((l): l is string => l != null),
    );

    const created: CreatedDropSlot[] = [];
    let skippedExisting = 0;

    for (const label of labels) {
      if (existingLabels.has(label)) {
        skippedExisting += 1;
        continue;
      }
      const row = await this.prisma.inventory.create({
        data: {
          tenantId,
          venueId,
          kind: InventoryKind.table,
          label,
          capacity,
          minSpend,
          deposit,
        },
      });
      created.push({
        id: row.id,
        label: row.label ?? label,
        minSpend: row.minSpend ?? minSpend,
        deposit: row.deposit ?? deposit,
        capacity: row.capacity ?? capacity,
      });
    }

    return { tenantId, venueId, created, skippedExisting };
  }
}

@ApiTags('ops:inventory')
@Controller('v1/ops/inventory')
export class InventoryDropController {
  constructor(private readonly svc: InventoryDropService) {}

  /** Drop a batch of late-night after-party inventory slots for a venue. */
  @Post('late-night-drop')
  @Scopes('ops:inventory:write')
  lateNightDrop(@Tenant() ctx: TenantContext, @Body() dto: LateNightDropDto) {
    return this.svc.lateNightDrop(ctx, dto);
  }
}

@Module({
  controllers: [InventoryDropController],
  providers: [InventoryDropService],
  exports: [InventoryDropService],
})
export class InventoryDropModule {}
