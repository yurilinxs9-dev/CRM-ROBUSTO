import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { LeadsModule } from '../leads/leads.module';
import { PublicApiController } from './public-api.controller';
import { PublicDocsController } from './public-docs.controller';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiService } from './public-api.service';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ScopesGuard } from './guards/scopes.guard';
import { PublicRateLimitGuard } from './guards/public-rate-limit.guard';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { AuditInterceptor } from './audit.interceptor';

/**
 * API HTTP pública (/api/v1) + gestão de API keys (/api/api-keys).
 * Reusa MessagesService (esteira de envio UazAPI). PrismaService e CrmGateway
 * vêm de módulos @Global (PrismaModule / WebSocketModule).
 */
@Module({
  imports: [MessagesModule, LeadsModule],
  controllers: [PublicApiController, PublicDocsController, ApiKeysController],
  providers: [
    PublicApiService,
    ApiKeyService,
    ApiKeyGuard,
    ScopesGuard,
    PublicRateLimitGuard,
    IdempotencyInterceptor,
    AuditInterceptor,
  ],
  exports: [ApiKeyService],
})
export class PublicApiModule {}
