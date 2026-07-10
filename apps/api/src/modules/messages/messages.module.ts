import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MediaModule } from '../media/media.module';
import { PushModule } from '../push/push.module';
import { MessagesSendProcessor } from './messages.processor';
import { MessagesRecoveryService } from './messages-recovery.service';
import { MESSAGES_SEND_QUEUE } from './messages.queue';

@Module({
  imports: [
    HttpModule,
    MediaModule,
    PushModule,
    BullModule.registerQueue({
      name: MESSAGES_SEND_QUEUE,
      defaultJobOptions: {
        // attempts=4 com backoff exponencial (10s, 20s, 40s): cobre instabilidade
        // curta da UazAPI (ex.: 503 momentâneo) sem ação humana. Envio não é
        // idempotente, mas o guard alreadySent() do processor confere o
        // whatsapp_message_id (vindo do echo webhook) antes de cada retry, então
        // se a msg JÁ saiu o retry é abortado — não duplica no cliente.
        // Falhas que sobrevivem às 4 tentativas viram FAILED e entram na
        // varredura de recuperação (MessagesRecoveryService).
        attempts: 4,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }),
  ],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesSendProcessor, MessagesRecoveryService],
  exports: [MessagesService],
})
export class MessagesModule {}
