import { Module } from '@nestjs/common';
import { BookingsModule } from './bookings.module';
import { InventoryModule } from './inventory.module';
import { DepositsModule } from './deposits.module';
import { PaymentsModule } from './payments.module';
import { TabModule } from './tab.module';
import { RoutingModule } from './routing.module';
import { DoorModule } from './door.module';
import { CloseoutModule } from './closeout.module';
import { PosBackfillModule } from './pos-backfill.module';
import { BookingConnectModule } from './booking-connect.module';
import { RevenuePromptsModule } from './revenue-prompts.module';
import { OverbookingModule } from './overbooking.module';
import { InventoryDropModule } from './inventory-drop.module';
import { OutlookModule } from './outlook.module';
import { ActionsModule } from './actions.module';
import { SplitGroupsModule } from './split-groups.module';

/** Ops hub — the 8 primitives that run BOOK & PAY, LIVE and WRAP. */
@Module({
  imports: [
    BookingsModule,
    InventoryModule,
    DepositsModule,
    PaymentsModule,
    TabModule,
    RoutingModule,
    DoorModule,
    CloseoutModule,
    PosBackfillModule,
    BookingConnectModule,
    RevenuePromptsModule,
    OverbookingModule,
    InventoryDropModule,
    // Ported from the 2026-07-23 Supabase design spike:
    OutlookModule,
    ActionsModule,
    SplitGroupsModule,
  ],
  exports: [
    BookingsModule,
    InventoryModule,
    DepositsModule,
    PaymentsModule,
    TabModule,
    DoorModule,
    CloseoutModule,
    SplitGroupsModule,
  ],
})
export class OpsModule {}
