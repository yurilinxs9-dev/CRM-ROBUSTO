import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { LeadsService } from './leads.service';

@Processor('leads-sync', { concurrency: 1 })
export class LeadsSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadsSyncProcessor.name);

  constructor(private leadsService: LeadsService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== 'daily-sync') return;
    const result = await this.leadsService.syncActiveLeadsProfiles(50);
    this.logger.log(`Sync diario concluido: ${result.synced} leads atualizados`);
  }
}
