import { Module } from '@nestjs/common';
import { StudioController } from './studio.controller';

@Module({ controllers: [StudioController] })
export class StudioModule {}
