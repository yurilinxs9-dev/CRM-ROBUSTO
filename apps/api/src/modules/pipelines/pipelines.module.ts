import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import {
  PipelineAutoActionsProcessor,
  PIPELINE_AUTO_ACTIONS_QUEUE,
} from './auto-actions.processor';
import { MessagesModule } from '../messages/messages.module';
import { KanbanIndividualModule } from './kanban-individual.module';
import { KanbanIndividualController } from './kanban-individual.controller';

@Module({
  imports: [
    BullModule.registerQueue({ name: PIPELINE_AUTO_ACTIONS_QUEUE }),
    MessagesModule,
    KanbanIndividualModule,
  ],
  controllers: [PipelinesController, KanbanIndividualController],
  providers: [PipelinesService, PipelineAutoActionsProcessor],
  exports: [PipelinesService, BullModule],
})
export class PipelinesModule {}
