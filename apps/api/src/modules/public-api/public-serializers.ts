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

// ---- Mensagens (contrato público de conversa) -----------------------------

export interface MessageSource {
  id: string;
  direction: 'INCOMING' | 'OUTGOING';
  type: string;
  content: string | null;
  media_url: string | null;
  status: string;
  created_at: Date;
}

export interface MessageDto {
  id: string;
  direction: 'incoming' | 'outgoing';
  type: string;
  text: string | null;
  media_url: string | null;
  status: string;
  created_at: string;
}

export function toMessageDto(m: MessageSource): MessageDto {
  return {
    id: m.id,
    direction: m.direction === 'INCOMING' ? 'incoming' : 'outgoing',
    type: m.type.toLowerCase(),
    text: m.content ?? null,
    // só expõe URL já pública (http); paths internos do Storage não vazam.
    media_url: m.media_url && /^https?:\/\//i.test(m.media_url) ? m.media_url : null,
    status: m.status.toLowerCase(),
    created_at: m.created_at.toISOString(),
  };
}

export const MESSAGE_SELECT = {
  id: true,
  direction: true,
  type: true,
  content: true,
  media_url: true,
  status: true,
  created_at: true,
} as const;
