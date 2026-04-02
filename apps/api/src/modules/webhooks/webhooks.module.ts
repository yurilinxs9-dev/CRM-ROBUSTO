import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhookProcessor } from './webhook.processor';
import { LeadsModule } from '../leads/leads.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          url: config.get('UPSTASH_REDIS_TLS_URL'),
          tls: { rejectUnauthorized: false },
        },
        defaultJobOptions: {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: { count: 100 },
          removeOnFail: { count: 50 },
        },
      }),
    }),
    BullModule.registerQueue({ name: 'webhooks' }),
    LeadsModule,
  ],
  controllers: [WebhooksController],
  providers: [WebhookProcessor],
})
export class WebhooksModule {}
