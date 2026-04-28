import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import { WebhooksController } from './webhooks.controller';
import { WebhookProcessor } from './webhook.processor';
import { LeadsModule } from '../leads/leads.module';
import { MediaModule } from '../media/media.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const url = config.get<string>('REDIS_URL') ?? config.get<string>('UPSTASH_REDIS_TLS_URL') ?? '';
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
  ],
  controllers: [WebhooksController],
  providers: [WebhookProcessor],
})
export class WebhooksModule {}
