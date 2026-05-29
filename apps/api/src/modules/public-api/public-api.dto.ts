import { z } from 'zod';

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

export const addTagsSchema = z.object({
  tags: z.array(z.string().min(1).max(50)).min(1).max(20),
});

export type ListContactsQuery = z.infer<typeof listContactsQuerySchema>;
export type SendConversationBody = z.infer<typeof sendConversationSchema>;
