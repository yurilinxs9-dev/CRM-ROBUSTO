import { z } from 'zod';
import { AiProvider } from '@prisma/client';

const providerEnum = z.nativeEnum(AiProvider);

export const createModelSchema = z.object({
  label: z.string().min(1).max(80),
  provider: providerEnum,
  base_url: z.string().url().max(300).optional().nullable(),
  model_id: z.string().min(1).max(200),
  api_key: z.string().min(1).max(500),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().min(1).max(200_000).optional(),
  is_default: z.boolean().optional(),
});

export const updateModelSchema = z.object({
  label: z.string().min(1).max(80).optional(),
  provider: providerEnum.optional(),
  base_url: z.string().url().max(300).optional().nullable(),
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
