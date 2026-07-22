import { Module } from '@nestjs/common';
import { AudiencesModule } from './audiences/audiences.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { AttributionModule } from './attribution/attribution.module';
import { PromotersModule } from './promoters/promoters.module';
import { RecommendationsModule } from './recommendations/recommendations.module';
import { WinbackModule } from './winback/winback.module';
import { ReportingModule } from './reporting/reporting.module';
import { EntitiesModule } from './entities/entities.module';
import { EventOffersModule } from './offers/event-offers.module';
import { CrewRebookModule } from './nudges/crew-rebook.module';
import { TasteSegmentsModule } from './audiences/taste-segments.module';

/**
 * Marketing hub — the 7 primitives (#17–#23) that turn the taste-graph moat into
 * discovery: Audience Studio, Discovery, Lifecycle/CRM, Attribution, Winback,
 * Reporting/BI, and the shared Entity catalog.
 */
@Module({
  imports: [
    AudiencesModule,
    DiscoveryModule,
    LifecycleModule,
    AttributionModule,
    PromotersModule,
    RecommendationsModule,
    WinbackModule,
    ReportingModule,
    EntitiesModule,
    EventOffersModule,
    CrewRebookModule,
    TasteSegmentsModule,
  ],
  exports: [
    AudiencesModule,
    DiscoveryModule,
    LifecycleModule,
    AttributionModule,
    PromotersModule,
    RecommendationsModule,
    WinbackModule,
    ReportingModule,
    EntitiesModule,
  ],
})
export class MarketingModule {}
