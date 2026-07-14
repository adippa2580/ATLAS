import { Module } from '@nestjs/common';
import { AudiencesModule } from './audiences/audiences.module';
import { DiscoveryModule } from './discovery/discovery.module';
import { LifecycleModule } from './lifecycle/lifecycle.module';
import { AttributionModule } from './attribution/attribution.module';
import { WinbackModule } from './winback/winback.module';
import { ReportingModule } from './reporting/reporting.module';
import { EntitiesModule } from './entities/entities.module';

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
    WinbackModule,
    ReportingModule,
    EntitiesModule,
  ],
  exports: [
    AudiencesModule,
    DiscoveryModule,
    LifecycleModule,
    AttributionModule,
    WinbackModule,
    ReportingModule,
    EntitiesModule,
  ],
})
export class MarketingModule {}
