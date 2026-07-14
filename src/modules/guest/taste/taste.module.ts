import { Module } from '@nestjs/common';
import { TasteController } from './taste.controller';
import { TasteService } from './taste.service';
import { AffinityRecomputeService } from './affinity-recompute.service';

@Module({
  controllers: [TasteController],
  providers: [TasteService, AffinityRecomputeService],
  exports: [TasteService, AffinityRecomputeService],
})
export class TasteModule {}
