import { z } from 'zod';
import { AiProvider } from '@prisma/client';

const providerEnum = z.nativeEnum(AiProvider);

/**
 * Whitelist padrão de hosts para base_url. Modelos são globais e os prompts
 * de copilot/suggest-reply/follow-up carregam conversas de qualquer tenant —
 * sem essa checagem, um admin restrito com escopo `ai` poderia apontar
 * base_url para um endpoint próprio e exfiltrar dados do tenant do admin
 * master. AI_ALLOWED_HOSTS (env, hosts separados por vírgula) SUBSTITUI esta
 * lista quando presente e não-vazia — vale para todos, inclusive o master.
 */
export const DEFAULT_ALLOWED_AI_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'api.groq.com',
  'api.deepseek.com',
  'api.mistral.ai',
  'api.x.ai',
  'api.together.xyz',
  'generativelanguage.googleapis.com',
];

function allowedAiHosts(): string[] {
  const fromEnv = process.env.AI_ALLOWED_HOSTS;
  if (fromEnv && fromEnv.trim() !== '') {
    return fromEnv
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== '');
  }
  return DEFAULT_ALLOWED_AI_HOSTS;
}

/**
 * Hosts internos da rede docker autorizados a usar http (LLM local, ex.: Ollama).
 * http só é aceito para ESTES hosts; todo host externo continua exigindo https.
 * AI_ALLOWED_INTERNAL_HOSTS (env, csv) SUBSTITUI esta lista, igual a
 * AI_ALLOWED_HOSTS — inclusive para esvaziá-la (`AI_ALLOWED_INTERNAL_HOSTS=` a
 * vazio mantém o padrão; com valor, só os hosts listados passam).
 */
export const DEFAULT_INTERNAL_AI_HOSTS = ['ollama'];

function allowedInternalAiHosts(): string[] {
  const fromEnv = process.env.AI_ALLOWED_INTERNAL_HOSTS;
  if (fromEnv && fromEnv.trim() !== '') {
    return fromEnv
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== '');
  }
  return DEFAULT_INTERNAL_AI_HOSTS;
}

/**
 * Host exato (case-insensitive) contra a whitelist. https é obrigatório para
 * hosts externos; http só passa nos hosts internos da rede docker.
 */
export function isValidBaseUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  const hostname = parsed.hostname.toLowerCase();
  if (parsed.protocol === 'http:') {
    return allowedInternalAiHosts().includes(hostname);
  }
  if (parsed.protocol !== 'https:') return false;
  return allowedAiHosts().includes(hostname);
}

const baseUrlSchema = z
  .string()
  .url()
  .max(300)
  .refine(isValidBaseUrl, { message: 'Host não permitido para base_url' })
  .optional()
  .nullable();

export const createModelSchema = z.object({
  label: z.string().min(1).max(80),
  provider: providerEnum,
  base_url: baseUrlSchema,
  model_id: z.string().min(1).max(200),
  api_key: z.string().min(1).max(500),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  is_default: z.boolean().optional(),
});

export const updateModelSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  provider: providerEnum.optional(),
  base_url: baseUrlSchema,
  model_id: z.string().min(1).max(200).optional(),
  // Só recifra a chave se vier preenchida — vazio/ausente preserva a atual.
  api_key: z.string().min(1).max(500).optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  active: z.boolean().optional(),
  is_default: z.boolean().optional(),
});

export const updateAgentSchema = z.object({
  system_prompt: z.string().max(20_000).optional(),
  persona: z.string().max(2_000).optional().nullable(),
  copilot_enabled: z.boolean().optional(),
  suggest_enabled: z.boolean().optional(),
  autoreply_enabled: z.boolean().optional(),
  followup_enabled: z.boolean().optional(),
  default_model_id: z.string().uuid().optional().nullable(),
});

export type CreateModelDto = z.infer<typeof createModelSchema>;
export type UpdateModelDto = z.infer<typeof updateModelSchema>;
export type UpdateAgentDto = z.infer<typeof updateAgentSchema>;
