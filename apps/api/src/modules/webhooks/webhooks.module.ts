import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhookProcessor } from './webhook.processor';
import { InboundMessageService } from './inbound-message.service';
import { ConversationService } from './conversation.service';
import { EvolutionEventsHandler } from './evolution-events.handler';
import { UazapiEventsHandler } from './uazapi-events.handler';
import { DataRetentionService } from './data-retention.service';
import { WebhookSecretGuard } from './guards/webhook-secret.guard';
import { LeadsModule } from '../leads/leads.module';
import { MediaModule } from '../media/media.module';
import { PushModule } from '../push/push.module';
import { QueueModule } from '../queue/queue.module';
import { BroadcastsModule } from '../broadcasts/broadcasts.module';
import { HistorySyncModule } from './history-sync.module';
import { AttributionModule } from '../attribution/attribution.module';
import { InstancesModule } from '../instances/instances.module';
import { KanbanIndividualModule } from '../pipelines/kanban-individual.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL') ?? '';
        return {
        connection: {
          url,
          ...(url.startsWith('rediss://') ? { tls: { rejectUnauthorized: false } } : {}),
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      };
      },
    }),
    BullModule.registerQueue({ name: 'webhooks' }),
    LeadsModule,
    MediaModule,
    PushModule,
    QueueModule,
    BroadcastsModule,
    HistorySyncModule,
    AttributionModule,
    // Só pelo InstanceHealthService: o connection.update → open fecha o alerta
    // do monitor na hora. Sem ciclo — InstancesModule não importa webhooks.
    InstancesModule,
    // Só a tradução de coluna do inbound (auto-assign e round-robin). O módulo
    // não importa nada, então não há ciclo com pipelines.
    KanbanIndividualModule,
  ],
  controllers: [WebhooksController],
  providers: [
    WebhookProcessor,
    InboundMessageService,
    ConversationService,
    EvolutionEventsHandler,
    UazapiEventsHandler,
    DataRetentionService,
    WebhookSecretGuard,
  ],
  exports: [ConversationService],
})
export class WebhooksModule {}
