import { Module } from '@nestjs/common';
import { IdentityModule } from './identity/identity.module';
import { ConsentModule } from './consent/consent.module';
import { EntryQrModule } from './consent/entry-qr.module';
import { ConsentAuditModule } from './consent/consent-audit.module';
import { CrewEngageModule } from './crew/crew-engage.module';
import { TasteModule } from './taste/taste.module';
import { CrewModule } from './crew/crew.module';
import { ConnectorsModule } from './connectors/connectors.module';
import { EntitlementsModule } from './misc/entitlements.module';
import { TrustLoyaltyModule } from './misc/trust-loyalty.module';

/** Guest hub — the 8 primitives that generate and hold the taste-graph moat. */
@Module({
  imports: [
    IdentityModule,
    ConsentModule,
    EntryQrModule,
    ConsentAuditModule,
    CrewEngageModule,
    TasteModule,
    CrewModule,
    ConnectorsModule,
    EntitlementsModule,
    TrustLoyaltyModule,
  ],
  exports: [IdentityModule, TasteModule, CrewModule, EntitlementsModule],
})
export class GuestModule {}
