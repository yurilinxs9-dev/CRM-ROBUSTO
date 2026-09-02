import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadTimelineService } from './lead-timeline.service';
import { CustomFieldsController, CustomFieldGroupsController } from './custom-fields.controller';
import { CustomFieldsService } from './custom-fields.service';
import { LeadsSyncProcessor } from './leads-sync.processor';
import { UnreadSweepService } from './unread-sweep.service';
import { InstancesModule } from '../instances/instances.module';
import { MediaModule } from '../media/media.module';
import { PushModule } from '../push/push.module';
import { QueueModule } from '../queue/queue.module';
import { PIPELINE_AUTO_ACTIONS_QUEUE } from '../pipelines/auto-actions.processor';
import { KanbanIndividualModule } from '../pipelines/kanban-individual.module';

const LEADS_SYNC_QUEUE = 'leads-sync';

class LeadsSyncScheduler implements OnModuleInit {
  private readonly logger = new Logger(LeadsSyncScheduler.name);
  constructor(@InjectQueue(LEADS_SYNC_QUEUE) private queue: Queue) {}

  async onModuleInit() {
    try {
      await this.queue.add(
        'daily-sync',
        {},
        {
          repeat: { pattern: '0 4 * * *' },
          jobId: 'leads-sync-daily',
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      this.logger.log('Cron diario de sync de perfis agendado (04:00)');
    } catch (err) {
      this.logger.warn(`Falha ao agendar cron de sync: ${String(err)}`);
    }
  }
}

@Module({
  imports: [
    InstancesModule,
    MediaModule,
    PushModule,
    QueueModule,
    // Só o service de tradução de coluna. O módulo não importa nada (é o
    // desenho dele), então não abre ciclo com pipelines.
    KanbanIndividualModule,
    BullModule.registerQueue({ name: LEADS_SYNC_QUEUE }),
    BullModule.registerQueue({ name: PIPELINE_AUTO_ACTIONS_QUEUE }),
  ],
  controllers: [LeadsController, CustomFieldsController, CustomFieldGroupsController],
  providers: [
    LeadsService,
    LeadTimelineService,
    CustomFieldsService,
    LeadsSyncProcessor,
    LeadsSyncScheduler,
    UnreadSweepService,
  ],
  exports: [LeadsService, CustomFieldsService],
})
export class LeadsModule {}
