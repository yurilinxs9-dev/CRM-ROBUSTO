import { Module } from '@nestjs/common';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastDispatcher } from './broadcast.dispatcher';
import { BroadcastSenderService } from './broadcast-sender.service';
import { BroadcastReplyService } from './broadcast-reply.service';
import { MessagesModule } from '../messages/messages.module';
import { AiModule } from '../ai/ai.module';

/**
 * Follow-up / broadcast por IA. Reusa MessagesService (envio) e AiProviderService
 * (geração de mensagem). O dispatcher (cron) já é ativado pelo ScheduleModule
 * global registrado no AppModule.
 *
 * BroadcastReplyService é exportado porque o módulo de webhooks o consome
 * para tirar o lead da fila assim que o cliente responde.
 */
@Module({
  imports: [MessagesModule, AiModule],
  controllers: [BroadcastsController],
  providers: [BroadcastsService, BroadcastDispatcher, BroadcastSenderService, BroadcastReplyService],
  exports: [BroadcastReplyService],
})
export class BroadcastsModule {}
