import { Module } from '@nestjs/common';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { BroadcastDispatcher } from './broadcast.dispatcher';
import { MessagesModule } from '../messages/messages.module';
import { AiModule } from '../ai/ai.module';

/**
 * Follow-up / broadcast por IA. Reusa MessagesService (envio) e AiProviderService
 * (geração de mensagem). O dispatcher (cron) já é ativado pelo ScheduleModule
 * global registrado no AppModule.
 */
@Module({
  imports: [MessagesModule, AiModule],
  controllers: [BroadcastsController],
  providers: [BroadcastsService, BroadcastDispatcher],
})
export class BroadcastsModule {}
