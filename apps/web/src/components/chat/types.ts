export type Temperatura = 'FRIO' | 'MORNO' | 'QUENTE' | 'MUITO_QUENTE';
export type MessageDirection = 'INCOMING' | 'OUTGOING' | 'INBOUND' | 'OUTBOUND';
export type MessageStatus =
  | 'PENDING'
  | 'SENT'
  | 'DELIVERED'
  | 'READ'
  | 'FAILED';
export type MessageType =
  | 'TEXT'
  | 'AUDIO'
  | 'IMAGE'
  | 'VIDEO'
  | 'DOCUMENT'
  | string;

export interface ChatLead {
  id: string;
  nome: string;
  telefone: string;
  temperatura: Temperatura;
  estagio_id: string;
  mensagens_nao_lidas: number;
  foto_url?: string | null;
  valor_estimado?: string | number | null;
  ultima_interacao?: string;
  email?: string | null;
  origem?: string | null;
  responsavel?: { id: string; nome: string } | null;
  created_at?: string;
  updated_at?: string;
  proximo_followup?: string | null;
  cadence_step_index?: number | null;
  estagio?: {
    id: string;
    nome: string;
    cor?: string;
    cadence_config?: {
      enabled?: boolean;
      steps?: Array<{ mode: string; template?: string; duration?: number; unit?: string }>;
    } | null;
  } | null;
}

export interface ChatMessage {
  id: string;
  whatsapp_message_id?: string;
  lead_id: string;
  content: string;
  type: MessageType;
  direction: MessageDirection;
  status: MessageStatus;
  is_internal_note: boolean;
  media_url?: string | null;
  media_mimetype?: string | null;
  media_filename?: string | null;
  media_size_bytes?: number | null;
  media_waveform_peaks?: number[] | null;
  media_poster_path?: string | null;
  media_thumbnail_path?: string | null;
  media_thumbnail_url?: string | null;
  media_archived?: boolean;
  created_at: string;
}

export interface ChatStage {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
}

export interface ChatPipeline {
  id: string;
  nome: string;
  stages: ChatStage[];
}

export interface MessagesPage {
  messages: ChatMessage[];
  nextCursor?: string;
}

export function isOutgoing(direction: MessageDirection): boolean {
  return direction === 'OUTGOING' || direction === 'OUTBOUND';
}

export function formatPhone(raw: string): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (digits.length === 13) {
    return `+${digits.slice(0, 2)} (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  if (digits.length === 10) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  }
  return raw;
}

export function getInitials(name: string): string {
  if (!name) return '?';
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

export function formatTime(dateStr: string): string {
  return new Date(dateStr).toLocaleTimeString('pt-BR', {
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function formatDateSeparator(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const start = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diffDays = Math.floor((start(now) - start(date)) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return 'Hoje';
  if (diffDays === 1) return 'Ontem';
  if (diffDays < 7) {
    return date.toLocaleDateString('pt-BR', { weekday: 'long' });
  }
  return date.toLocaleDateString('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

export function getDateKey(dateStr: string): string {
  const d = new Date(dateStr);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

export function formatBytes(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
