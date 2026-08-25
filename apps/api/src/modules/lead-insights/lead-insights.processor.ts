import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { LeadInsightsService } from './lead-insights.service';
import { LEAD_INSIGHTS_QUEUE, type GerarInsightJobData } from './lead-insights.queue';

/**
 * Concorrencia 1 de proposito: o modelo que gera a ficha e local (uma GPU/CPU
 * so). Dois jobs em paralelo nao geram mais fichas — geram duas filas lentas.
 */
@Processor(LEAD_INSIGHTS_QUEUE, { concurrency: 1 })
export class LeadInsightsProcessor extends WorkerHost {
  private readonly logger = new Logger(LeadInsightsProcessor.name);

  constructor(private readonly insights: LeadInsightsService) {
    super();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job<GerarInsightJobData> | undefined, err: Error) {
    this.logger.error(
      `Insight job FAILED id=${job?.id ?? '?'} lead=${job?.data?.leadId ?? '?'} attempts=${job?.attemptsMade ?? 0}: ${err?.message ?? err}`,
      err?.stack,
    );
  }

  async process(job: Job<GerarInsightJobData>): Promise<void> {
    const { leadId, tenantId } = job.data;
    await this.insights.gerarInsight(leadId, tenantId);
  }
}
