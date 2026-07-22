import {
  Body,
  Controller,
  Injectable,
  Module,
  NotFoundException,
  Post,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsBoolean, IsISO8601, IsOptional, IsString } from 'class-validator';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Scopes } from '../../../common/auth/scopes.decorator';
import { Tenant, TenantContext } from '../../../common/tenancy/tenant-context';
import { EventsFeedAdapter } from '../../../integrations/eventsfeed.adapter';

class IngestDto {
  @IsString() city!: string;
}

class CompetitorDto {
  @IsString() entityId!: string;
  @IsBoolean() competitor!: boolean;
  /** Opening date makes the rival groundable for recommendations. */
  @IsOptional() @IsISO8601() openingDate?: string;
}

/**
 * Catalog ingest — automatic class-3 population of the shared entity catalog
 * from the public events feed, replacing seed-only data. Idempotent: rows are
 * matched on externalRefs.sourceId first (then kind+name), so re-running a
 * city sync updates dates/genres instead of duplicating.
 *
 * Competitor flagging is deliberately a separate, curated call: the feed can
 * discover that "Rival Rooftop" exists; only the operator can say it competes.
 */
@Injectable()
export class CatalogIngestService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly feed: EventsFeedAdapter,
  ) {}

  private async findExisting(
    kind: 'event' | 'venue',
    sourceId: string,
    name: string,
  ) {
    const bySource = await this.prisma.entity.findFirst({
      where: {
        kind,
        externalRefs: { path: ['sourceId'], equals: sourceId },
      },
    });
    if (bySource) return bySource;
    return this.prisma.entity.findFirst({ where: { kind, name } });
  }

  async ingest(_ctx: TenantContext, dto: IngestDto) {
    const feed = await this.feed.fetchCity(dto.city);
    let created = 0;
    let updated = 0;

    for (const ev of feed.events) {
      const existing = await this.findExisting('event', ev.sourceId, ev.name);
      const metadata = {
        ...((existing?.metadata as object) ?? {}),
        date: ev.date,
        genres: ev.genres,
        city: ev.city,
        venueName: ev.venueName,
        source: feed.source,
      } as Prisma.InputJsonValue;
      const externalRefs = {
        ...((existing?.externalRefs as object) ?? {}),
        sourceId: ev.sourceId,
        source: feed.source,
      } as Prisma.InputJsonValue;
      if (existing) {
        await this.prisma.entity.update({
          where: { id: existing.id },
          data: { metadata, externalRefs },
        });
        updated++;
      } else {
        await this.prisma.entity.create({
          data: { kind: 'event', name: ev.name, metadata, externalRefs },
        });
        created++;
      }
    }

    for (const vn of feed.venues) {
      const existing = await this.findExisting('venue', vn.sourceId, vn.name);
      const metadata = {
        ...((existing?.metadata as object) ?? {}),
        city: vn.city,
        source: feed.source,
      } as Prisma.InputJsonValue;
      const externalRefs = {
        ...((existing?.externalRefs as object) ?? {}),
        sourceId: vn.sourceId,
        source: feed.source,
      } as Prisma.InputJsonValue;
      if (existing) {
        await this.prisma.entity.update({
          where: { id: existing.id },
          data: { metadata, externalRefs },
        });
        updated++;
      } else {
        await this.prisma.entity.create({
          data: { kind: 'venue', name: vn.name, metadata, externalRefs },
        });
        created++;
      }
    }

    return {
      source: feed.source,
      city: feed.city,
      stub: feed.stub,
      events: feed.events.length,
      venues: feed.venues.length,
      created,
      updated,
    };
  }

  /** Curated judgement: mark a catalog venue as a competitor (or clear it). */
  async markCompetitor(_ctx: TenantContext, dto: CompetitorDto) {
    const entity = await this.prisma.entity.findUnique({
      where: { id: dto.entityId },
    });
    if (!entity || entity.kind !== 'venue') {
      throw new NotFoundException('Catalog venue not found');
    }
    const metadata = {
      ...((entity.metadata as object) ?? {}),
      competitor: dto.competitor,
      ...(dto.openingDate ? { openingDate: dto.openingDate } : {}),
    } as Prisma.InputJsonValue;
    const saved = await this.prisma.entity.update({
      where: { id: entity.id },
      data: { metadata },
    });
    return {
      id: saved.id,
      name: saved.name,
      competitor: dto.competitor,
      openingDate: dto.openingDate ?? null,
    };
  }
}

@ApiTags('marketing:catalog')
@Controller('v1/catalog')
export class CatalogIngestController {
  constructor(private readonly service: CatalogIngestService) {}

  @Post('ingest')
  @Scopes('mkt:reporting:write')
  ingest(@Tenant() ctx: TenantContext, @Body() dto: IngestDto) {
    return this.service.ingest(ctx, dto);
  }

  @Post('competitors')
  @Scopes('mkt:reporting:write')
  markCompetitor(@Tenant() ctx: TenantContext, @Body() dto: CompetitorDto) {
    return this.service.markCompetitor(ctx, dto);
  }
}

@Module({
  providers: [CatalogIngestService],
  controllers: [CatalogIngestController],
  exports: [CatalogIngestService],
})
export class CatalogIngestModule {}
