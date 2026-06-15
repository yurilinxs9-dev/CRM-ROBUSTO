import type { AiProvider } from '@prisma/client';

/** Mensagem no formato neutro de chat (role + texto). */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Opções por chamada (sobrepõem os defaults do AiModelConfig). */
export interface AiChatOptions {
  temperature?: number;
  maxTokens?: number;
}

/** Resultado normalizado de uma chamada de IA. */
export interface AiChatResult {
  text: string;
  tokensIn: number;
  tokensOut: number;
}

/** Modelo já resolvido (chave decifrada) entregue ao adapter. */
export interface ResolvedModel {
  provider: AiProvider;
  baseUrl: string | null;
  modelId: string;
  apiKey: string;
  temperature: number;
  maxTokens: number;
}

/** Contrato de cada adapter de provedor. */
export interface AiProviderAdapter {
  readonly provider: AiProvider;
  chat(model: ResolvedModel, messages: AiChatMessage[], opts?: AiChatOptions): Promise<AiChatResult>;
}
