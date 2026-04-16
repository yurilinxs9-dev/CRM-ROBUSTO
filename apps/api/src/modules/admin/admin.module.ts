import { Module, MiddlewareConsumer, NestModule } from '@nestjs/common';
import { BullBoardModule } from '@bull-board/nestjs';
import { ExpressAdapter } from '@bull-board/express';
import { BullModule } from '@nestjs/bullmq';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { AdminAuthMiddleware } from '../../common/middleware/admin-auth.middleware';
import { MESSAGES_SEND_QUEUE } from '../messages/messages.queue';

const WEBHOOKS_QUEUE = 'webhooks';

@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_SECRET') }),
      inject: [ConfigService],
    }),
    BullBoardModule.forRoot({
      route: '/admin/queues',
      adapter: ExpressAdapter,
    }),
    BullModule.registerQueue({ name: MESSAGES_SEND_QUEUE }),
    BullModule.registerQueue({ name: WEBHOOKS_QUEUE }),
    BullBoardModule.forFeature(
      { name: MESSAGES_SEND_QUEUE, adapter: BullMQAdapter },
      { name: WEBHOOKS_QUEUE, adapter: BullMQAdapter },
    ),
  ],
  providers: [AdminAuthMiddleware],
})
export class AdminModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(AdminAuthMiddleware).forRoutes('/admin/queues*');
  }
}
