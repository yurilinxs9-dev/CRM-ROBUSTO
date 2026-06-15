import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AiConfigController } from './ai-config.controller';
import { AiConfigService } from './ai-config.service';
import { AiChatController } from './ai-chat.controller';
import { AiChatService } from './ai-chat.service';
import { AiProviderService } from './ai-provider.service';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import { AnthropicAdapter } from './providers/anthropic.adapter';
import { OpenAiCompatibleAdapter } from './providers/openai-compatible.adapter';

/**
 * IA nativa do CRM. AiProviderService é exportado p/ ser consumido por outros
 * módulos (copilot/suggest/auto-reply/follow-up). PrismaService é @Global.
 */
@Module({
  imports: [ConfigModule],
  controllers: [AiConfigController, AiChatController],
  providers: [
    AiProviderService,
    AiConfigService,
    AiChatService,
    AnthropicAdapter,
    OpenAiCompatibleAdapter,
    PlatformAdminGuard,
  ],
  exports: [AiProviderService],
})
export class AiModule {}
