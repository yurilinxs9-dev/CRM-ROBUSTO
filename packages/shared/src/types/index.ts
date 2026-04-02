export type UserRole = 'SUPER_ADMIN' | 'GERENTE' | 'OPERADOR' | 'VISUALIZADOR';
export type LeadOrigem = 'WHATSAPP_INCOMING' | 'WHATSAPP_OUTGOING' | 'MANUAL' | 'IMPORT' | 'LANDING_PAGE' | 'INDICACAO';
export type LeadTemperatura = 'FRIO' | 'MORNO' | 'QUENTE' | 'MUITO_QUENTE';
export type MessageDirection = 'INCOMING' | 'OUTGOING';
export type MessageType = 'TEXT' | 'AUDIO' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | 'STICKER' | 'LOCATION' | 'CONTACT';
export type MessageStatus = 'PENDING' | 'SENT' | 'DELIVERED' | 'READ' | 'FAILED';
export type InstanceStatus = 'connected' | 'disconnected' | 'connecting' | 'error';

export interface User {
  id: string;
  nome: string;
  email: string;
  role: UserRole;
  avatar_url?: string;
  ativo: boolean;
}

export interface Lead {
  id: string;
  nome: string;
  telefone: string;
  email?: string;
  empresa?: string;
  temperatura: LeadTemperatura;
  score: number;
  mensagens_nao_lidas: number;
  ultima_interacao?: string;
  instancia_whatsapp: string;
  estagio_id: string;
  responsavel_id: string;
  pipeline_id: string;
  created_at: string;
}

export interface Message {
  id: string;
  lead_id: string;
  direction: MessageDirection;
  type: MessageType;
  content?: string;
  media_url?: string;
  media_duration_seconds?: number;
  status: MessageStatus;
  is_internal_note: boolean;
  created_at: string;
}

export interface Stage {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  pipeline_id: string;
  is_won: boolean;
  is_lost: boolean;
}

export interface WhatsappInstance {
  id: string;
  nome: string;
  telefone?: string;
  status: InstanceStatus;
  ultimo_check?: string;
}

export interface ServerToClientEvents {
  'lead:stage-changed': (data: { leadId: string; estagio_id: string }) => void;
  'lead:new-message': (data: { leadId: string; message: Message }) => void;
  'message:new': (message: Message) => void;
  'message:status-updated': (data: { messageId: string; status: MessageStatus }) => void;
  'instance:status-changed': (data: { instanceName: string; status: InstanceStatus }) => void;
  'instance:qr-code': (data: { instanceName: string; qrCode: string }) => void;
}

export interface ClientToServerEvents {
  'join:lead': (leadId: string) => void;
  'leave:lead': (leadId: string) => void;
}
