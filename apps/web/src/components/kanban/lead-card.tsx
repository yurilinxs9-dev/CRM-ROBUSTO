'use client';

import { forwardRef, type HTMLAttributes } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
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

interface LeadCardProps extends HTMLAttributes<HTMLDivElement> {
  lead: Lead;
  isDragging?: boolean;
}

export const LeadCard = forwardRef<HTMLDivElement, LeadCardProps>(
  ({ lead, isDragging, className, ...props }, ref) => {
    return (
      <Card
        ref={ref}
        className={cn(
          'p-3 cursor-grab active:cursor-grabbing transition-colors hover:bg-accent/50',
          isDragging && 'opacity-50 rotate-1 shadow-xl',
          className
        )}
        {...props}
      >
        <div className="flex items-start gap-2 mb-2">
          <Avatar className="h-8 w-8 shrink-0">
            {lead.foto_url ? (
              <AvatarImage src={lead.foto_url} alt={lead.nome} />
            ) : null}
            <AvatarFallback className="text-xs font-semibold">
              {getInitials(lead.nome)}
            </AvatarFallback>
          </Avatar>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-semibold truncate">{lead.nome}</p>
            <p className="text-xs text-muted-foreground truncate">
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

        {lead.tags && lead.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-2">
            {lead.tags.slice(0, 3).map((t) => (
              <Badge key={t} variant="outline" className="text-[10px] px-1.5 py-0">
                {t}
              </Badge>
            ))}
          </div>
        )}

        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-emerald-500">
            {formatBRL(lead.valor_estimado)}
          </span>
          <span className="text-muted-foreground">{timeAgo(lead.ultima_interacao)}</span>
        </div>
      </Card>
    );
  }
);

LeadCard.displayName = 'LeadCard';
