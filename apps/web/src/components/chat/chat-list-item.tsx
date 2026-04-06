'use client';

import { memo } from 'react';
import { format, isToday, isYesterday, isThisWeek } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Flame } from 'lucide-react';

import { cn } from '@/lib/cn';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';

export type Temperatura = 'FRIO' | 'MORNO' | 'QUENTE' | 'MUITO_QUENTE';

export interface ChatLead {
  id: string;
  nome: string;
  telefone: string;
  temperatura: Temperatura;
  estagio_id: string;
  mensagens_nao_lidas: number;
  foto_url?: string | null;
  ultima_interacao?: string;
  ultimo_mensagem?: string;
  responsavel?: { id: string; nome: string };
}

interface ChatListItemProps {
  lead: ChatLead;
  active: boolean;
  onClick: () => void;
}

function formatRelativeTime(date?: string): string {
  if (!date) return '';
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  if (isToday(d)) return format(d, 'HH:mm');
  if (isYesterday(d)) return 'Ontem';
  if (isThisWeek(d, { locale: ptBR })) return format(d, 'EEE', { locale: ptBR });
  return format(d, 'dd/MM/yy');
}

function getInitials(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');
}

function formatPhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 12 && digits.startsWith('55')) {
    const ddd = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length === 9) {
      return `+55 (${ddd}) ${rest.slice(0, 5)}-${rest.slice(5)}`;
    }
    if (rest.length === 8) {
      return `+55 (${ddd}) ${rest.slice(0, 4)}-${rest.slice(4)}`;
    }
  }
  return phone;
}

function ChatListItemComponent({ lead, active, onClick }: ChatListItemProps) {
  const isHot = lead.temperatura === 'QUENTE' || lead.temperatura === 'MUITO_QUENTE';
  const hasUnread = lead.mensagens_nao_lidas > 0;

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'w-full flex items-start gap-3 px-4 py-3 text-left border-b border-border/50 transition-colors',
        'hover:bg-accent/50 focus:outline-none focus:bg-accent/60',
        active && 'bg-accent'
      )}
    >
      <div className="relative flex-shrink-0">
        <Avatar className="h-11 w-11">
          {lead.foto_url ? (
            <AvatarImage src={lead.foto_url} alt={lead.nome} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-primary text-sm font-semibold">
            {getInitials(lead.nome) || '?'}
          </AvatarFallback>
        </Avatar>
        {isHot && (
          <span className="absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full bg-green-500 border-2 border-background" />
        )}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-center justify-between gap-2">
          <span
            className={cn(
              'text-sm truncate',
              hasUnread ? 'font-semibold text-foreground' : 'font-medium text-foreground'
            )}
          >
            {lead.nome}
          </span>
          <span
            className={cn(
              'text-xs flex-shrink-0',
              hasUnread ? 'text-primary font-medium' : 'text-muted-foreground'
            )}
          >
            {formatRelativeTime(lead.ultima_interacao)}
          </span>
        </div>

        <div className="flex items-center justify-between gap-2 mt-0.5">
          <p
            className={cn(
              'text-xs truncate',
              hasUnread ? 'text-foreground/80' : 'text-muted-foreground'
            )}
          >
            {lead.ultimo_mensagem || 'Sem mensagens ainda'}
          </p>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {isHot && (
              <Flame
                className={cn(
                  'h-3.5 w-3.5',
                  lead.temperatura === 'MUITO_QUENTE' ? 'text-red-500' : 'text-orange-500'
                )}
              />
            )}
            {hasUnread && (
              <Badge className="h-5 min-w-[20px] px-1.5 rounded-full text-[10px] font-bold tabular-nums">
                {lead.mensagens_nao_lidas > 99 ? '99+' : lead.mensagens_nao_lidas}
              </Badge>
            )}
          </div>
        </div>

        <p className="text-[11px] text-muted-foreground mt-0.5 truncate">
          {formatPhone(lead.telefone)}
        </p>
      </div>
    </button>
  );
}

export const ChatListItem = memo(ChatListItemComponent);
