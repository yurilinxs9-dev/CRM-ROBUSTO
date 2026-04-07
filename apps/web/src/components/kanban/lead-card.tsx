'use client';

import { forwardRef, memo, type HTMLAttributes, type MouseEvent } from 'react';
import { formatDistanceToNowStrict, differenceInCalendarDays } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { MessageCircle, CheckSquare, Archive, AlertTriangle } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';

export type Temperatura = 'FRIO' | 'MORNO' | 'QUENTE' | 'MUITO_QUENTE';

export interface Lead {
  id: string;
  nome: string;
  telefone: string;
  temperatura: Temperatura;
  estagio_id: string;
  mensagens_nao_lidas: number;
  foto_url?: string | null;
  valor_estimado?: string | null;
  ultima_interacao?: string | null;
  ultima_mensagem_preview?: string | null;
  responsavel?: { id: string; nome: string } | null;
  tags?: string[];
  estagio_entered_at?: string | null;
  pending_tasks_count?: number;
}

export const TEMP_LABELS: Record<Temperatura, string> = {
  FRIO: 'Frio',
  MORNO: 'Morno',
  QUENTE: 'Quente',
  MUITO_QUENTE: 'Fogo',
};

const TEMP_BADGE: Record<Temperatura, string> = {
  FRIO: 'bg-sky-500/15 text-sky-400 border-sky-500/30',
  MORNO: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
  QUENTE: 'bg-orange-500/15 text-orange-400 border-orange-500/30',
  MUITO_QUENTE: 'bg-red-500/15 text-red-400 border-red-500/30',
};

export function formatBRL(value?: string | null): string {
  if (!value) return '';
  const n = Number(value);
  if (Number.isNaN(n)) return '';
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

export function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 13 && digits.startsWith('55')) {
    return `+55 (${digits.slice(2, 4)}) ${digits.slice(4, 9)}-${digits.slice(9)}`;
  }
  if (digits.length === 11) {
    return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
  }
  return phone;
}

function getInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
}

function timeAgo(date?: string | null): string {
  if (!date) return '';
  try {
    return `há ${formatDistanceToNowStrict(new Date(date), { locale: ptBR })}`;
  } catch {
    return '';
  }
}

function daysInStage(date?: string | null): number | null {
  if (!date) return null;
  try {
    return differenceInCalendarDays(new Date(), new Date(date));
  } catch {
    return null;
  }
}

interface LeadCardProps extends HTMLAttributes<HTMLDivElement> {
  lead: Lead;
  isDragging?: boolean;
  stageMaxDias?: number | null;
  onOpenChat?: (leadId: string) => void;
  onQuickTask?: (leadId: string) => void;
  onArchiveLead?: (leadId: string) => void;
}

const LeadCardImpl = forwardRef<HTMLDivElement, LeadCardProps>(
  (
    { lead, isDragging, stageMaxDias, onOpenChat, onQuickTask, onArchiveLead, className, ...props },
    ref,
  ) => {
    const hasUnread = lead.mensagens_nao_lidas > 0;
    const dis = daysInStage(lead.estagio_entered_at);
    const overdue = dis !== null && stageMaxDias != null && dis > stageMaxDias;
    const pendingTasks = lead.pending_tasks_count ?? 0;

    const stop = (e: MouseEvent) => e.stopPropagation();

    return (
      <Card
        ref={ref}
        className={cn(
          'group relative p-3 cursor-grab active:cursor-grabbing transition-colors hover:bg-accent/50',
          isDragging && 'opacity-50 rotate-1 shadow-xl',
          className,
        )}
        {...props}
      >
        {/* SLA pulsing badge */}
        {overdue && (
          <div
            className="absolute -top-1.5 -right-1.5 flex h-5 items-center gap-1 rounded-full bg-red-500 px-1.5 text-[10px] font-semibold text-white shadow ring-2 ring-background animate-pulse"
            title={`SLA estourado: ${dis} dias na etapa (max ${stageMaxDias})`}
          >
            <AlertTriangle className="h-3 w-3" />
            {dis}d
          </div>
        )}

        {/* Unread blue dot */}
        {hasUnread && !overdue && (
          <div
            className="absolute -top-1 -right-1 h-3 w-3 rounded-full bg-blue-500 ring-2 ring-background"
            title={`${lead.mensagens_nao_lidas} mensagens nao lidas`}
          />
        )}

        <div className="flex items-start gap-2 mb-2">
          <Avatar className="h-8 w-8 shrink-0">
            {lead.foto_url ? <AvatarImage src={lead.foto_url} alt={lead.nome} /> : null}
            <AvatarFallback className="text-xs font-semibold">
              {getInitials(lead.nome)}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{lead.nome}</p>
            <p className="text-xs text-muted-foreground truncate flex items-center gap-1">
              <MessageCircle className="h-3 w-3 text-emerald-500" />
              {formatPhone(lead.telefone)}
            </p>
          </div>
          <Badge variant="outline" className={cn('text-[10px]', TEMP_BADGE[lead.temperatura])}>
            {TEMP_LABELS[lead.temperatura]}
          </Badge>
        </div>

        {lead.ultima_mensagem_preview && (
          <p className="text-xs text-muted-foreground line-clamp-1 mb-2">
            {lead.ultima_mensagem_preview}
          </p>
        )}

        {((lead.tags && lead.tags.length > 0) || pendingTasks > 0) && (
          <div className="flex flex-wrap items-center gap-1 mb-2">
            {pendingTasks > 0 && (
              <Badge
                variant="outline"
                className="text-[10px] px-1.5 py-0 border-amber-500/40 bg-amber-500/10 text-amber-500"
              >
                <CheckSquare className="mr-0.5 h-2.5 w-2.5" />
                {pendingTasks}
              </Badge>
            )}
            {lead.tags?.slice(0, 3).map((t) => (
              <Badge key={t} variant="outline" className="text-[10px] px-1.5 py-0">
                {t}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-emerald-500">{formatBRL(lead.valor_estimado)}</span>
          <span className="text-muted-foreground">{timeAgo(lead.ultima_interacao)}</span>
        </div>

        {/* Hover action buttons */}
        {(onOpenChat || onQuickTask || onArchiveLead) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center justify-end gap-1 rounded-b-lg bg-gradient-to-t from-background/95 via-background/80 to-transparent p-1.5 opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100">
            {onOpenChat && (
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  onOpenChat(lead.id);
                }}
                className="rounded p-1 text-emerald-500 hover:bg-emerald-500/10"
                title="Abrir conversa"
              >
                <MessageCircle className="h-3.5 w-3.5" />
              </button>
            )}
            {onQuickTask && (
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  onQuickTask(lead.id);
                }}
                className="rounded p-1 text-amber-500 hover:bg-amber-500/10"
                title="Nova tarefa"
              >
                <CheckSquare className="h-3.5 w-3.5" />
              </button>
            )}
            {onArchiveLead && (
              <button
                type="button"
                onClick={(e) => {
                  stop(e);
                  onArchiveLead(lead.id);
                }}
                className="rounded p-1 text-muted-foreground hover:bg-accent"
                title="Arquivar lead"
              >
                <Archive className="h-3.5 w-3.5" />
              </button>
            )}
          </div>
        )}
      </Card>
    );
  },
);

LeadCardImpl.displayName = 'LeadCard';

export const LeadCard = memo(LeadCardImpl);
