import { Module } from '@nestjs/common';
import { OutcomesController } from './outcomes.controller';

@Module({ controllers: [OutcomesController] })
export class OutcomesModule {}
