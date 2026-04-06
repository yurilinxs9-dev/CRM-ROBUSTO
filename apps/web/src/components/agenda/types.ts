export type TaskType = 'FOLLOW_UP' | 'LIGACAO' | 'REUNIAO' | 'EMAIL' | 'VISITA' | 'OUTRO';
export type TaskStatus = 'PENDENTE' | 'CONCLUIDA' | 'CANCELADA' | 'ATRASADA';
export type Prioridade = 'BAIXA' | 'MEDIA' | 'ALTA' | 'URGENTE';

export interface AgendaTask {
  id: string;
  titulo: string;
  descricao?: string | null;
  tipo: TaskType;
  status: TaskStatus;
  prioridade: Prioridade;
  scheduled_at: string;
  completed_at?: string | null;
  duracao_min?: number | null;
  lead_id?: string | null;
  responsavel_id: string;
  lead?: { id: string; nome: string; telefone: string; foto_url?: string | null } | null;
  responsavel?: { id: string; nome: string; avatar_url?: string | null };
}

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  FOLLOW_UP: 'Follow-up',
  LIGACAO: 'Ligação',
  REUNIAO: 'Reunião',
  EMAIL: 'E-mail',
  VISITA: 'Visita',
  OUTRO: 'Outro',
};

export const PRIORIDADE_LABELS: Record<Prioridade, string> = {
  BAIXA: 'Baixa',
  MEDIA: 'Média',
  ALTA: 'Alta',
  URGENTE: 'Urgente',
};

export const PRIORIDADE_COLOR: Record<Prioridade, string> = {
  BAIXA: 'border-l-muted-foreground/40',
  MEDIA: 'border-l-primary',
  ALTA: 'border-l-amber-500',
  URGENTE: 'border-l-destructive',
};

export const PRIORIDADE_BADGE: Record<Prioridade, string> = {
  BAIXA: 'bg-muted text-muted-foreground',
  MEDIA: 'bg-primary/15 text-primary',
  ALTA: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
  URGENTE: 'bg-destructive/15 text-destructive',
};
