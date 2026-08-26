import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { LeadInsightsService } from './lead-insights.service';
import { LEAD_INSIGHTS_QUEUE, type GerarInsightJobData } from './lead-insights.queue';

/**
 * Concorrencia padrao 1 de proposito: com modelo LOCAL (uma CPU so), dois jobs
 * em paralelo nao geram mais fichas — geram duas filas lentas. Com provedor de
 * API remoto (DeepSeek etc.), LEAD_INSIGHTS_CONCURRENCY sobe o paralelismo
 * (ex.: 10) — lido uma vez no boot do worker.
 */
const CONCORRENCIA = Math.max(
  1,
  Math.min(20, Number(process.env.LEAD_INSIGHTS_CONCURRENCY) || 1),
);

@Processor(LEAD_INSIGHTS_QUEUE, { concurrency: CONCORRENCIA })
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
