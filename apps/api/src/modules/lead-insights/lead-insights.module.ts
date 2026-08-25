import { Global, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LeadsModule } from '../leads/leads.module';
import { AiModule } from '../ai/ai.module';
import { LeadInsightsController } from './lead-insights.controller';
import { LeadInsightsService } from './lead-insights.service';
import { LeadInsightsProcessor } from './lead-insights.processor';
import { LEAD_INSIGHTS_QUEUE } from './lead-insights.queue';

/**
 * @Global porque o gatilho vive no inbound (WebhooksModule), que nao pode
 * importar este modulo sem ciclo — mesmo arranjo do OutboundWebhooksModule.
 *
 * `removeOnComplete/Fail: true` NAO e cosmetico: o jobId `lead-<id>` e a
 * deduplicacao da rajada, e o BullMQ recusa um jobId que ainda exista em
 * completed/failed. Guardar historico aqui congelaria o lead em uma unica
 * geracao para sempre.
 */
@Global()
@Module({
  imports: [
    LeadsModule,
    AiModule,
    BullModule.registerQueue({
      name: LEAD_INSIGHTS_QUEUE,
      defaultJobOptions: {
        attempts: 2,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    }),
  ],
  controllers: [LeadInsightsController],
  providers: [LeadInsightsService, LeadInsightsProcessor],
  exports: [LeadInsightsService],
})
export class LeadInsightsModule {}
