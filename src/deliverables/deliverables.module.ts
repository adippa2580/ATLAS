import { Module } from '@nestjs/common';
import { DeliverablesController } from './deliverables.controller';

@Module({ controllers: [DeliverablesController] })
export class DeliverablesModule {}
