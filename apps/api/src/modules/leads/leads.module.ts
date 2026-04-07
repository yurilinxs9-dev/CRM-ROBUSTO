import { Module, OnModuleInit, Logger } from '@nestjs/common';
import { BullModule, InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadsSyncProcessor } from './leads-sync.processor';
import { InstancesModule } from '../instances/instances.module';
import { PIPELINE_AUTO_ACTIONS_QUEUE } from '../pipelines/auto-actions.processor';

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
    BullModule.registerQueue({ name: LEADS_SYNC_QUEUE }),
    BullModule.registerQueue({ name: PIPELINE_AUTO_ACTIONS_QUEUE }),
  ],
  controllers: [LeadsController],
  providers: [LeadsService, LeadsSyncProcessor, LeadsSyncScheduler],
  exports: [LeadsService],
})
export class LeadsModule {}
