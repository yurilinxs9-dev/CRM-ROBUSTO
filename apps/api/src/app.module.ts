import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { HealthController } from './modules/health/health.controller';
import { ThrottlerModule } from '@nestjs/throttler';
import { TasksModule } from './modules/tasks/tasks.module';
import { AuthModule } from './modules/auth/auth.module';
import { LeadsModule } from './modules/leads/leads.module';
import { MessagesModule } from './modules/messages/messages.module';
import { InstancesModule } from './modules/instances/instances.module';
import { PipelinesModule } from './modules/pipelines/pipelines.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import { WebhooksModule } from './modules/webhooks/webhooks.module';
import { WebSocketModule } from './modules/websocket/websocket.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { TagsModule } from './modules/tags/tags.module';
import { QuickRepliesModule } from './modules/quick-replies/quick-replies.module';
import { UsersModule } from './modules/users/users.module';
import { MediaModule } from './modules/media/media.module';
import { PrismaModule } from './common/prisma/prisma.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    TasksModule,
    AuthModule,
    LeadsModule,
    MessagesModule,
    InstancesModule,
    PipelinesModule,
    DashboardModule,
    WebhooksModule,
    WebSocketModule,
    NotificationsModule,
    TagsModule,
    QuickRepliesModule,
    UsersModule,
    MediaModule,
  ],
})
export class AppModule {}
