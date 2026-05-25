import { Module, Global } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { OutboundWebhooksController } from './outbound-webhooks.controller';
import { OutboundWebhooksService } from './outbound-webhooks.service';
import { OutboundWebhooksProcessor } from './outbound-webhooks.processor';
import { OutboundWebhooksCron } from './outbound-webhooks.cron';
import { OUTBOUND_WEBHOOKS_QUEUE } from './outbound-webhooks.queue';

@Global()
@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue({
      name: OUTBOUND_WEBHOOKS_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: { count: 500 },
        removeOnFail: { count: 1000 },
      },
    }),
  ],
  controllers: [OutboundWebhooksController],
  providers: [OutboundWebhooksService, OutboundWebhooksProcessor, OutboundWebhooksCron],
  exports: [OutboundWebhooksService],
})
export class OutboundWebhooksModule {}
