import { Global, Module } from '@nestjs/common';
import { EvidenceBus } from './evidence-bus';

@Global()
@Module({
  providers: [EvidenceBus],
  exports: [EvidenceBus],
})
export class EvidenceModule {}
