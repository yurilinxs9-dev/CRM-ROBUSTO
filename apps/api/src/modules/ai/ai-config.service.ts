import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiModelConfig } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from './ai-provider.service';
import { decryptSecret, encryptSecret, maskKey } from './ai-crypto.util';
import type { CreateModelDto, UpdateAgentDto, UpdateModelDto } from './ai.dto';

/** Versão segura do modelo p/ o client: NUNCA expõe a chave (só máscara). */
function sanitize(cfg: AiModelConfig, envKey: string | undefined) {
  let key_mask = '••••';
  try {
    key_mask = maskKey(decryptSecret(cfg.api_key_enc, envKey));
  } catch {
    // chave corrompida ou env trocado — mantém máscara genérica
  }
  return {
    id: cfg.id,
    label: cfg.label,
    provider: cfg.provider,
    base_url: cfg.base_url,
    model_id: cfg.model_id,
    key_mask,
    temperature: cfg.temperature,
    max_tokens: cfg.max_tokens,
    active: cfg.active,
    is_default: cfg.is_default,
    created_at: cfg.created_at,
    updated_at: cfg.updated_at,
  };
}

/**
 * CRUD de modelos de IA + config do agente. Escopo de PLATAFORMA — protegido
 * pelo PlatformAdminGuard no controller (só super admin).
 */
@Injectable()
export class AiConfigService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly provider: AiProviderService,
  ) {}

  private get envKey(): string | undefined {
    return this.config.get<string>('AI_ENCRYPTION_KEY');
  }

  async listModels() {
    const rows = await this.prisma.aiModelConfig.findMany({ orderBy: { created_at: 'desc' } });
    return rows.map((r) => sanitize(r, this.envKey));
  }

  async createModel(userId: string, dto: CreateModelDto) {
    const created = await this.prisma.$transaction(async (tx) => {
      if (dto.is_default) {
        await tx.aiModelConfig.updateMany({ where: { is_default: true }, data: { is_default: false } });
      }
      return tx.aiModelConfig.create({
        data: {
          label: dto.label,
          provider: dto.provider,
          base_url: dto.base_url ?? null,
          model_id: dto.model_id,
          api_key_enc: encryptSecret(dto.api_key, this.envKey),
          temperature: dto.temperature ?? 0.7,
          max_tokens: dto.max_tokens ?? 1024,
          is_default: dto.is_default ?? false,
          created_by: userId,
        },
      });
    });
    return sanitize(created, this.envKey);
  }

  async updateModel(id: string, dto: UpdateModelDto) {
    const exists = await this.prisma.aiModelConfig.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Modelo de IA não encontrado');

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.is_default) {
        await tx.aiModelConfig.updateMany({
          where: { is_default: true, NOT: { id } },
          data: { is_default: false },
        });
      }
      return tx.aiModelConfig.update({
        where: { id },
        data: {
          ...(dto.label !== undefined ? { label: dto.label } : {}),
          ...(dto.provider !== undefined ? { provider: dto.provider } : {}),
          ...(dto.base_url !== undefined ? { base_url: dto.base_url } : {}),
          ...(dto.model_id !== undefined ? { model_id: dto.model_id } : {}),
          ...(dto.api_key ? { api_key_enc: encryptSecret(dto.api_key, this.envKey) } : {}),
          ...(dto.temperature !== undefined ? { temperature: dto.temperature } : {}),
          ...(dto.max_tokens !== undefined ? { max_tokens: dto.max_tokens } : {}),
          ...(dto.active !== undefined ? { active: dto.active } : {}),
          ...(dto.is_default !== undefined ? { is_default: dto.is_default } : {}),
        },
      });
    });
    return sanitize(updated, this.envKey);
  }

  async deleteModel(id: string) {
    const exists = await this.prisma.aiModelConfig.findUnique({ where: { id } });
    if (!exists) throw new NotFoundException('Modelo de IA não encontrado');
    // SetNull em AiUsageLog preserva o histórico de uso/custo.
    await this.prisma.aiModelConfig.delete({ where: { id } });
    return { ok: true };
  }

  /** Smoke-test: manda um ping curto pro modelo e devolve a resposta. */
  async testModel(id: string) {
    const result = await this.provider.chat({
      modelConfigId: id,
      feature: 'copilot',
      messages: [
        { role: 'user', content: 'Responda apenas com a palavra: OK' },
      ],
      opts: { maxTokens: 16 },
    });
    return { ok: true, sample: result.text.trim().slice(0, 200), tokens_in: result.tokensIn, tokens_out: result.tokensOut };
  }

  // ── Config do agente (singleton) ───────────────────────────────────────────
  async getAgentConfig() {
    const existing = await this.prisma.aiAgentConfig.findFirst({ orderBy: { created_at: 'asc' } });
    if (existing) return existing;
    return this.prisma.aiAgentConfig.create({ data: {} });
  }

  async updateAgentConfig(dto: UpdateAgentDto) {
    const current = await this.getAgentConfig();
    if (dto.default_model_id) {
      const m = await this.prisma.aiModelConfig.findUnique({ where: { id: dto.default_model_id } });
      if (!m) throw new BadRequestException('default_model_id inválido');
    }
    return this.prisma.aiAgentConfig.update({ where: { id: current.id }, data: dto });
  }
}
