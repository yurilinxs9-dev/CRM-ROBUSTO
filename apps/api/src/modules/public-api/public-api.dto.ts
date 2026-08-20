import { z } from 'zod';
import { attributionInputSchema } from '../attribution/attribution.types';

export const listContactsQuerySchema = z.object({
  email: z.string().email().optional(),
  phone: z.string().min(3).max(30).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const sendConversationSchema = z.object({
  user_id: z.string().uuid({ message: 'user_id deve ser um UUID válido' }),
  message: z.string().min(1).max(4096),
  channel: z.literal('whatsapp').optional().default('whatsapp'),
  type: z.literal('text').optional().default('text'),
});

export const updateStatusSchema = z.object({
  status: z.string().min(1),
});

export const moveToSectorSchema = z.object({
  sector_id: z.string().uuid({ message: 'sector_id deve ser um UUID válido' }),
});

export const addTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(50)).min(1).max(20),
});

export const createContactSchema = z.object({
  name: z.string().min(1).max(200),
  phone: z.string().min(8).max(30),
  email: z.string().email().optional(),
  tags: z.array(z.string().min(1).max(50)).max(20).optional(),
  // Chave → valor dos campos personalizados do tenant. As chaves são as de
  // GET /v1/custom-fields; o valor é validado e convertido contra a definição
  // do campo (mesma rotina que a ficha do lead usa), não gravado cru.
  dados_custom: z.record(z.unknown()).optional(),
  // Origem do lead (utm_*, gclid, referrer…), como o snippet do site capturou.
  // Opcional: integração que não manda nada continua funcionando igual, o lead
  // só entra no relatório como não identificado.
  attribution: attributionInputSchema.optional(),
});

export const moveStageSchema = z.object({
  stage_id: z.string().uuid({ message: 'stage_id deve ser um UUID válido' }),
});

export const createActivitySchema = z.object({
  descricao: z.string().min(1).max(500),
  // Livre de propósito: a timeline do lead já é um mural heterogêneo
  // ('stage_change', 'lead_created', …) e cada integração tem o seu vocabulário.
  tipo: z.string().min(1).max(50).optional(),
});

export const conversationMessagesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
});

export const updateContactSchema = z
  .object({
    name: z.string().min(1).max(200).optional(),
    email: z.string().email().nullable().optional(),
    tags: z.array(z.string().min(1).max(50)).max(50).optional(),
    dados_custom: z.record(z.unknown()).optional(),
  })
  .refine(
    (d) =>
      d.name !== undefined ||
      d.email !== undefined ||
      d.tags !== undefined ||
      d.dados_custom !== undefined,
    { message: 'Nada para atualizar (envie name, email, tags ou dados_custom)' },
  );

export const listConversationsQuerySchema = z.object({
  status: z.enum(['open', 'pending', 'resolved', 'OPEN', 'PENDING', 'RESOLVED']).optional(),
  tag: z.string().min(1).max(50).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
export type SendConversationBody = z.infer<typeof sendConversationSchema>;
