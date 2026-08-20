import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { PlatformAdminController } from './platform-admin.controller';
import { AnnouncementsController } from './announcements.controller';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { HistorySyncModule } from '../webhooks/history-sync.module';

/**
 * Painel do admin de plataforma (acima dos tenants): tenants, logs,
 * impersonação com auditoria e anúncios/avisos. PrismaService é @Global.
 */
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      useFactory: (config: ConfigService) => ({ secret: config.get<string>('JWT_SECRET') }),
      inject: [ConfigService],
    }),
    HistorySyncModule,
  ],
  controllers: [PlatformAdminController, AnnouncementsController],
  providers: [PlatformAdminService, PlatformAdminGuard],
})
export class PlatformAdminModule {}
