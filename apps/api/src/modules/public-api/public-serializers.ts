import type { ConversationStatus } from '@prisma/client';

/** Forma mínima de Lead necessária para serializar como "contato" público. */
export interface ContactSource {
  id: string;
  nome: string;
  email: string | null;
  telefone: string;
  tags: unknown;
  atendimento_status: ConversationStatus;
  created_at: Date;
}

export interface ContactDto {
  id: string;
  name: string;
  email: string | null;
  phone: string;
  tags: string[];
  status: ConversationStatus;
  created_at: string;
}

/**
 * Mapeia um Lead interno para o contrato público de "contato".
 * Expõe SOMENTE campos do contrato — nunca responsavel_id, tenant_id, score,
 * dados internos do funil, etc.
 */
export function toContactDto(lead: ContactSource): ContactDto {
  return {
    id: lead.id,
    name: lead.nome,
    email: lead.email ?? null,
    phone: lead.telefone,
    tags: Array.isArray(lead.tags) ? (lead.tags as string[]) : [],
    status: lead.atendimento_status,
    created_at: lead.created_at.toISOString(),
  };
}

export const CONTACT_SELECT = {
  id: true,
  nome: true,
  email: true,
  telefone: true,
  tags: true,
  atendimento_status: true,
  created_at: true,
} as const;
