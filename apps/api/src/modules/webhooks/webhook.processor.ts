import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EvolutionEventsHandler } from './evolution-events.handler';
import { UazapiEventsHandler } from './uazapi-events.handler';

/**
 * Dispatcher da fila de webhooks (F2.2): 1 handler por evento, cada provider
 * no seu arquivo. Persistência/mídia/notificações vivem no
 * InboundMessageService; aqui só roteamento + telemetria de falha.
 */
@Processor('webhooks', { concurrency: 3 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private prisma: PrismaService,
    private evolution: EvolutionEventsHandler,
    private uazapi: UazapiEventsHandler,
  ) {
    super();
  }
  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    // Surface silent BullMQ failures in container logs so bugs like the
    // stale Prisma Client / missing column don't hide as queue "failed" count.
    this.logger.error(
      `Webhook job FAILED name=${job?.name ?? '?'} id=${job?.id ?? '?'} attempts=${job?.attemptsMade ?? 0}: ${err?.message ?? err}`,
      err?.stack,
    );
  }

  async process(job: Job) {
    const start = Date.now();
    try {
      switch (job.name) {
        case 'onmessage':
          await this.uazapi.handleWppMessage(job.data);
          break;
        case 'status-find':
          await this.uazapi.handleWppStatus(job.data);
          break;
        case 'messages.upsert':
          await this.evolution.handleMessageUpsert(job.data);
          break;
        case 'messages.update':
          await this.evolution.handleMessageUpdate(job.data);
          break;
        case 'connection.update':
          await this.evolution.handleConnectionUpdate(job.data);
          break;
        case 'contacts.upsert':
          await this.evolution.handleContactsUpsert(job.data);
          break;
        case 'chats.update':
        case 'chats.upsert':
          await this.evolution.handleChatsUpdate(job.data);
          break;
        case 'uazapi.messages':
        case 'uazapi.message':
          await this.uazapi.handleUazapiMessage(job.data);
          break;
        case 'uazapi.messages_update':
        case 'uazapi.message_ack':
          await this.uazapi.handleUazapiMessageAck(job.data);
          break;
        case 'uazapi.connection':
        case 'uazapi.connection_update':
          await this.uazapi.handleUazapiConnectionUpdate(job.data);
          break;
        case 'uazapi.chats':
          await this.uazapi.handleUazapiChats(job.data);
          break;
        default:
          this.logger.warn(`Evento nao suportado: ${job.name}`);
      }

      const processingTime = Date.now() - start;
      await this.prisma.webhookLog.updateMany({
        where: { event: job.name, processed: false },
        data: { processed: true, processing_time_ms: processingTime },
      });
    } catch (error) {
      this.logger.error(`Erro no webhook ${job.name}:`, error);
      await this.prisma.webhookLog.updateMany({
        where: { event: job.name, processed: false },
        data: { error: String(error) },
      });
      throw error;
    }
  }
}
