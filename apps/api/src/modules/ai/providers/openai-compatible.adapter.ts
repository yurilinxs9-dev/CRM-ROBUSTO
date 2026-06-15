import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { AiProvider } from '@prisma/client';
import type { AiChatMessage, AiChatOptions, AiChatResult, AiProviderAdapter, ResolvedModel } from '../ai.types';

/**
 * Adapter para qualquer endpoint compatível com a API /chat/completions da
 * OpenAI: OpenAI, OpenRouter, Groq, Together, Ollama local, etc. O super admin
 * escolhe `base_url` + `model_id` livre, então plugar um modelo novo não exige
 * deploy. Usa fetch nativo (Node 20+).
 */
@Injectable()
export class OpenAiCompatibleAdapter implements AiProviderAdapter {
  readonly provider = AiProvider.openai_compatible;
  private readonly logger = new Logger(OpenAiCompatibleAdapter.name);

  async chat(model: ResolvedModel, messages: AiChatMessage[], opts?: AiChatOptions): Promise<AiChatResult> {
    const baseUrl = (model.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
    const url = `${baseUrl}/chat/completions`;

    const body = {
      model: model.modelId,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      temperature: opts?.temperature ?? model.temperature,
      max_tokens: opts?.maxTokens ?? model.maxTokens,
    };

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${model.apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      this.logger.error(`Falha de rede ao chamar ${baseUrl}: ${String(err)}`);
      throw new BadGatewayException('Falha ao contatar o provedor de IA');
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`Provedor IA respondeu ${res.status}: ${detail.slice(0, 500)}`);
      throw new BadGatewayException(`Provedor de IA retornou ${res.status}`);
    }

    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };

    const text = json.choices?.[0]?.message?.content ?? '';
    return {
      text,
      tokensIn: json.usage?.prompt_tokens ?? 0,
      tokensOut: json.usage?.completion_tokens ?? 0,
    };
  }
}
