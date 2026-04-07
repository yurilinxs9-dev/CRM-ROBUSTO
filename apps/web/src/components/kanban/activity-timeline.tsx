'use client';

import { useQuery } from '@tanstack/react-query';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { ArrowRight, CheckSquare, Pencil, Plus, Activity } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { api } from '@/lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LeadActivityItem {
  id: string;
  tipo: string;
  descricao: string;
  dados_antes: Record<string, unknown> | null;
  dados_depois: Record<string, unknown> | null;
  created_at: string;
  user: { id: string; nome: string } | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TIPO_LABEL: Record<string, string> = {
  stage_change: 'Estagio alterado',
  lead_created: 'Lead criado',
  lead_updated: 'Lead atualizado',
  task_created: 'Tarefa criada',
};

function getTipoLabel(tipo: string): string {
  return TIPO_LABEL[tipo] ?? tipo;
}

function getTipoIcon(tipo: string) {
  switch (tipo) {
    case 'stage_change':
      return <ArrowRight className="h-3.5 w-3.5" />;
    case 'task_created':
      return <CheckSquare className="h-3.5 w-3.5" />;
    case 'lead_updated':
      return <Pencil className="h-3.5 w-3.5" />;
    case 'lead_created':
      return <Plus className="h-3.5 w-3.5" />;
    default:
      return <Activity className="h-3.5 w-3.5" />;
  }
}

function formatRelative(dateStr: string): string {
  try {
    return `há ${formatDistanceToNowStrict(new Date(dateStr), { locale: ptBR })}`;
  } catch {
    return dateStr;
  }
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ActivityTimelineProps {
  leadId: string;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function ActivityTimeline({ leadId }: ActivityTimelineProps) {
  const { data: activities, isLoading } = useQuery<LeadActivityItem[]>({
    queryKey: ['lead-activities', leadId],
    queryFn: async () => {
      const res = await api.get(`/api/leads/${leadId}/activities`);
      return res.data as LeadActivityItem[];
    },
    enabled: !!leadId,
  });

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex gap-3">
            <Skeleton className="h-6 w-6 rounded-full shrink-0" />
            <div className="flex-1 space-y-1.5">
              <Skeleton className="h-3.5 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (!activities || activities.length === 0) {
    return (
      <p className="text-xs text-muted-foreground py-2">Nenhuma atividade ainda</p>
    );
  }

  return (
    <ol className="relative space-y-0">
      {activities.map((item, idx) => (
        <li key={item.id} className="flex gap-3">
          {/* Vertical line */}
          <div className="flex flex-col items-center">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
              {getTipoIcon(item.tipo)}
            </span>
            {idx < activities.length - 1 && (
              <span className="w-px flex-1 bg-border mt-1 mb-1" />
            )}
          </div>

          {/* Content */}
          <div className="pb-4 flex-1 min-w-0">
            <p className="text-xs font-medium leading-tight">{getTipoLabel(item.tipo)}</p>
            <p className="text-xs text-muted-foreground mt-0.5 break-words">{item.descricao}</p>
            <p className="text-[10px] text-muted-foreground/70 mt-1">
              {formatRelative(item.created_at)}
              {item.user ? ` · ${item.user.nome}` : ''}
            </p>
          </div>
        </li>
      ))}
    </ol>
  );
}
