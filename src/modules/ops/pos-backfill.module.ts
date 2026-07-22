import { Body, Controller, Injectable, Module, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';
import { Provenance, Signal, SubjectType } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvidenceBus } from '../../common/evidence/evidence-bus';
import { Scopes } from '../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../common/tenancy/tenant-context';
import { evidenceDedupeKey } from '../../common/util/hash';
import { categorizeSku } from '../../insights/ops/ops-insights.module';

/** A single tab line item as persisted in Tab.lineItems (Prisma Json). */
type LineItem = { name: string; amount: number };

/** Defensive read of Tab.lineItems (Prisma Json) into a typed array. */
function readLineItems(raw: unknown): LineItem[] {
  if (!Array.isArray(raw)) return [];
  return (raw as { name?: unknown; amount?: unknown }[])
    .filter((li) => li && typeof li === 'object')
    .map((li) => ({
      name: typeof li.name === 'string' ? li.name : '',
      amount: typeof li.amount === 'number' ? li.amount : 0,
    }));
}

class PosBackfillDto {
  /** Optional venue narrowing — backfill a single room instead of the tenant. */
  @IsOptional() @IsString() venueId?: string;
}

/** Summary of a backfill run. */
export interface PosBackfillSummary {
  tenantId: string;
  tabsScanned: number;
  evidenceEmitted: number;
}

/**
 * Backfill menu affinities from POS — turn historical tabs into taste evidence.
 *
 * Every closed/settled tab is a record of what a guest actually paid for. This
 * job walks the tenant's settled tabs, categorises each SKU on the tab into a
 * taste subject (champagne, tequila, wine, …) and emits a `spend` affinity
 * signal (provenance `pos`) for the tab's guest via the EvidenceBus — so
 * historical spend becomes taste the graph can recommend on.
 *
 * Idempotent: the dedupeKey is derived per tab-line (`pos | <tabId>:<idx> |
 * spend`), and AffinityEvidence is uniquely keyed on (tenantId, dedupeKey), so
 * re-running the backfill never double-counts a line item.
 */
@Injectable()
export class PosBackfillService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bus: EvidenceBus,
  ) {}

  async backfill(
    ctx: TenantContext,
    dto: PosBackfillDto = {},
  ): Promise<PosBackfillSummary> {
    const t = ctx.tenantId;

    // Settled tabs only (closedAt set) — an open tab isn't evidence yet. All
    // reads are tenant-scoped; the booking gives us the guest to attribute to.
    const tabs = await this.prisma.tab.findMany({
      where: {
        tenantId: t,
        closedAt: { not: null },
        ...(dto.venueId ? { booking: { venueId: dto.venueId } } : {}),
      },
      include: {
        booking: { select: { guestId: true } },
      },
    });

    let evidenceEmitted = 0;
    for (const tab of tabs) {
      const guestId = tab.booking?.guestId;
      if (!guestId) continue;

      const observedAt = (tab.closedAt ?? tab.createdAt).toISOString();
      const items = readLineItems(tab.lineItems as unknown);

      for (let i = 0; i < items.length; i++) {
        const li = items[i];
        // A refund / comp / zero line carries no taste; skip it.
        if (li.amount <= 0) continue;

        const category = categorizeSku(li.name);

        // Spend magnitude weights the signal: one point per $10 spent, floored
        // at 1 so even a modest order registers as taste.
        const weight = Math.max(1, Math.round(li.amount / 1000));

        await this.bus.publish({
          tenantId: t,
          guestId,
          subjectType: SubjectType.product,
          subjectRef: category,
          signal: Signal.spend,
          weight,
          provenance: Provenance.pos,
          dedupeKey: evidenceDedupeKey('pos', `${tab.id}:${i}`, 'spend'),
          observedAt,
        });
        evidenceEmitted++;
      }
    }

    return { tenantId: t, tabsScanned: tabs.length, evidenceEmitted };
  }
}

@ApiTags('ops:pos-backfill')
@Controller('ops/pos-backfill')
export class PosBackfillController {
  constructor(private readonly svc: PosBackfillService) {}

  /**
   * Replay the tenant's settled POS tabs into `spend` taste evidence. Idempotent
   * — safe to re-run; dedupeKeys prevent double-counting.
   */
  @Post()
  @Scopes('mkt:reporting:write')
  backfill(@Tenant() ctx: TenantContext, @Body() dto: PosBackfillDto) {
    return this.svc.backfill(ctx, dto);
  }
}

@Module({
  controllers: [PosBackfillController],
  providers: [PosBackfillService],
  exports: [PosBackfillService],
})
export class PosBackfillModule {}
