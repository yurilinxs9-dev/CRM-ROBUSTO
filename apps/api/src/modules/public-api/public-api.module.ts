import { Module } from '@nestjs/common';
import { MessagesModule } from '../messages/messages.module';
import { PublicApiController } from './public-api.controller';
import { ApiKeysController } from './api-keys.controller';
import { PublicApiService } from './public-api.service';
import { ApiKeyService } from './api-key.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ScopesGuard } from './guards/scopes.guard';
import { PublicRateLimitGuard } from './guards/public-rate-limit.guard';

/**
 * API HTTP pública (/api/v1) + gestão de API keys (/api/api-keys).
 * Reusa MessagesService (esteira de envio UazAPI). PrismaService e CrmGateway
 * vêm de módulos @Global (PrismaModule / WebSocketModule).
 */
@Module({
  imports: [MessagesModule],
  controllers: [PublicApiController, ApiKeysController],
  providers: [
    PublicApiService,
    ApiKeyService,
    ApiKeyGuard,
    ScopesGuard,
    PublicRateLimitGuard,
  ],
  exports: [ApiKeyService],
})
export class PublicApiModule {}
