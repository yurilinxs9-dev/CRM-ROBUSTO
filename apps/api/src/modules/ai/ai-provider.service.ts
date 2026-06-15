import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiFeature, AiModelConfig, AiProvider } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { decryptSecret } from './ai-crypto.util';
import { AnthropicAdapter } from './providers/anthropic.adapter';
import { OpenAiCompatibleAdapter } from './providers/openai-compatible.adapter';
import type { AiChatMessage, AiChatOptions, AiChatResult, AiProviderAdapter, ResolvedModel } from './ai.types';

export interface AiChatRequest {
  /** Modelo específico; se ausente usa o default da plataforma. */
  modelConfigId?: string | null;
  feature: AiFeature;
  messages: AiChatMessage[];
  opts?: AiChatOptions;
  /** Para auditoria/custo (opcional). */
  tenantId?: string | null;
  leadId?: string | null;
}

/**
 * Núcleo da IA: resolve o AiModelConfig (platform-scoped), decifra a chave,
 * despacha pro adapter do provedor e registra uso/custo em AiUsageLog.
 */
@Injectable()
export class AiProviderService {
  private readonly logger = new Logger(AiProviderService.name);
  private readonly adapters: Map<AiProvider, AiProviderAdapter>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    anthropic: AnthropicAdapter,
    openai: OpenAiCompatibleAdapter,
  ) {
    this.adapters = new Map<AiProvider, AiProviderAdapter>([
      [anthropic.provider, anthropic],
      [openai.provider, openai],
    ]);
  }

  /** Modelo default ativo da plataforma (is_default=true), ou null. */
  async getDefaultModel(): Promise<AiModelConfig | null> {
    return this.prisma.aiModelConfig.findFirst({
      where: { active: true, is_default: true },
      orderBy: { created_at: 'desc' },
    });
  }

  private async resolveConfig(modelConfigId?: string | null): Promise<AiModelConfig> {
    if (modelConfigId) {
      const cfg = await this.prisma.aiModelConfig.findFirst({
        where: { id: modelConfigId, active: true },
      });
      if (!cfg) throw new NotFoundException('Modelo de IA não encontrado ou inativo');
      return cfg;
    }
    const def = await this.getDefaultModel();
    if (!def) {
      throw new BadRequestException('Nenhum modelo de IA padrão configurado pela plataforma');
    }
    return def;
  }

  async chat(req: AiChatRequest): Promise<AiChatResult> {
    const cfg = await this.resolveConfig(req.modelConfigId);
    const adapter = this.adapters.get(cfg.provider);
    if (!adapter) {
      throw new BadRequestException(`Provedor de IA não suportado: ${cfg.provider}`);
    }

    const resolved: ResolvedModel = {
      provider: cfg.provider,
      baseUrl: cfg.base_url,
      modelId: cfg.model_id,
      apiKey: decryptSecret(cfg.api_key_enc, this.config.get<string>('AI_ENCRYPTION_KEY')),
      temperature: cfg.temperature,
      maxTokens: cfg.max_tokens,
    };

    const result = await adapter.chat(resolved, req.messages, req.opts);

    // Auditoria de uso (best-effort: falha de log não derruba a resposta).
    this.prisma.aiUsageLog
      .create({
        data: {
          tenant_id: req.tenantId ?? null,
          model_config_id: cfg.id,
          feature: req.feature,
          tokens_in: result.tokensIn,
          tokens_out: result.tokensOut,
          lead_id: req.leadId ?? null,
        },
      })
      .catch((err) => this.logger.warn(`AiUsageLog falhou: ${String(err)}`));

    return result;
  }
}
