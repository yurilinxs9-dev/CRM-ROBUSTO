import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MediaModule } from '../media/media.module';
import { MessagesSendProcessor } from './messages.processor';
import { MESSAGES_SEND_QUEUE } from './messages.queue';

@Module({
  imports: [
    HttpModule,
    MediaModule,
    BullModule.registerQueue({
      name: MESSAGES_SEND_QUEUE,
      defaultJobOptions: {
        attempts: 5,
        backoff: { type: 'exponential', delay: 10_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 200 },
      },
    }),
  ],
  controllers: [MessagesController],
  providers: [MessagesService, MessagesSendProcessor],
  exports: [MessagesService],
})
export class MessagesModule {}
