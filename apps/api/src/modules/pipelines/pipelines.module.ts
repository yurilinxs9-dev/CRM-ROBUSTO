import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import {
  PipelineAutoActionsProcessor,
  PIPELINE_AUTO_ACTIONS_QUEUE,
} from './auto-actions.processor';

@Module({
  imports: [BullModule.registerQueue({ name: PIPELINE_AUTO_ACTIONS_QUEUE })],
  controllers: [PipelinesController],
  providers: [PipelinesService, PipelineAutoActionsProcessor],
  exports: [PipelinesService, BullModule],
})
export class PipelinesModule {}
