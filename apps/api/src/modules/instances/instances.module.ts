import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { InstanceHealthService } from './instance-health.service';
import { HistorySyncModule } from '../webhooks/history-sync.module';
import { PushModule } from '../push/push.module';
import { KanbanIndividualModule } from '../pipelines/kanban-individual.module';

@Module({
  // KanbanIndividualModule: trocar o responsável do número leva os leads para
  // o board do novo dono (setOwner). O módulo não importa ninguém — sem ciclo.
  imports: [HttpModule, HistorySyncModule, PushModule, KanbanIndividualModule],
  controllers: [InstancesController],
  providers: [InstancesService, InstanceHealthService],
  exports: [InstancesService, InstanceHealthService],
})
export class InstancesModule {}
