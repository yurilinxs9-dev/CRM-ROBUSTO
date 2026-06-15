import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { AiProvider } from '@prisma/client';
import type { AiChatMessage, AiChatOptions, AiChatResult, AiProviderAdapter, ResolvedModel } from '../ai.types';

/**
 * Adapter para a API nativa da Anthropic (Claude) via SDK oficial.
 *
 * Particularidades respeitadas:
 * - `system` é parâmetro separado, não entra em `messages` (mensagens system do
 *   formato neutro são concatenadas no campo system).
 * - `temperature` NÃO é enviado: os modelos atuais (Opus 4.7/4.8, Fable) retornam
 *   400 se receberem temperature/top_p. Deixamos o modelo no default.
 * - `max_tokens` é obrigatório.
 */
@Injectable()
export class AnthropicAdapter implements AiProviderAdapter {
  readonly provider = AiProvider.anthropic;
  private readonly logger = new Logger(AnthropicAdapter.name);

  async chat(model: ResolvedModel, messages: AiChatMessage[], opts?: AiChatOptions): Promise<AiChatResult> {
    const client = new Anthropic({
      apiKey: model.apiKey,
      ...(model.baseUrl ? { baseURL: model.baseUrl } : {}),
    });

    const system = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');

    const turns = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    try {
      const res = await client.messages.create({
        model: model.modelId,
        max_tokens: opts?.maxTokens ?? model.maxTokens,
        ...(system ? { system } : {}),
        messages: turns,
      });

      const text = res.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');

      return {
        text,
        tokensIn: res.usage.input_tokens,
        tokensOut: res.usage.output_tokens,
      };
    } catch (err) {
      if (err instanceof Anthropic.APIError) {
        this.logger.error(`Anthropic ${err.status}: ${err.message}`);
        throw new BadGatewayException(`Provedor Anthropic retornou ${err.status ?? 'erro'}`);
      }
      this.logger.error(`Falha ao chamar Anthropic: ${String(err)}`);
      throw new BadGatewayException('Falha ao contatar a Anthropic');
    }
  }
}
