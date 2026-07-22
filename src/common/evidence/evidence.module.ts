import { Global, Module } from '@nestjs/common';
import { EvidenceBus } from './evidence-bus';
import { OutboxRelayService } from './outbox.service';

@Global()
@Module({
  providers: [EvidenceBus, OutboxRelayService],
  exports: [EvidenceBus, OutboxRelayService],
})
export class EvidenceModule {}
