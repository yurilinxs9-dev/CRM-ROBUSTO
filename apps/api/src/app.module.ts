import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AllExceptionFilter } from './common/filters/all-exception.filter';
import { HealthController } from './modules/health/health.controller';
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler';
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
import { AnalyticsModule } from './modules/analytics/analytics.module';
import { AdminModule } from './modules/admin/admin.module';
import { AutomationModule } from './modules/automation/automation.module';
import { TenantsModule } from './modules/tenants/tenants.module';
import { PushModule } from './modules/push/push.module';
import { PrismaModule } from './common/prisma/prisma.module';
import { CacheModule } from './common/cache/cache.module';

@Module({
  controllers: [HealthController],
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../.env'],
    }),
    LoggerModule.forRootAsync({
      imports: [ConfigModule],
      useFactory: () => {
        const isProd = process.env.NODE_ENV === 'production';
        return {
          pinoHttp: {
            transport: isProd ? undefined : {
              target: 'pino-pretty',
              options: { singleLine: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,req,res' },
            },
            level: process.env.LOG_LEVEL ?? (isProd ? 'info' : 'debug'),
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.headers["x-api-key"]',
                'req.body.password',
                'req.body.senha',
                'req.body.token',
                'req.body.newPassword',
                'req.body.currentPassword',
                'req.body.confirmPassword',
                'req.body.secret',
                '*.password',
                '*.senha',
                '*.token',
                '*.secret',
                '*.uazapi_token',
              ],
              remove: false,
            },
            customProps: (req: import('http').IncomingMessage) => ({
              requestId: (req.headers['x-request-id'] as string | undefined),
            }),
            autoLogging: {
              ignore: (req: import('http').IncomingMessage) =>
                req.url === '/api/health' || req.url === '/health',
            },
          },
        };
      },
    }),
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot([{ ttl: 60000, limit: 100 }]),
    PrismaModule,
    CacheModule,
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
    AnalyticsModule,
    AdminModule,
    AutomationModule,
    TenantsModule,
    PushModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: AllExceptionFilter },
    { provide: APP_GUARD, useClass: ThrottlerGuard },
  ],
})
export class AppModule {}
