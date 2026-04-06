'use client';

import Link from 'next/link';
import { format } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { Check, Pencil, Trash2, Phone, Users, Mail, MapPin, MessageCircle, CircleDot, Clock } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/cn';
import {
  AgendaTask,
  PRIORIDADE_BADGE,
  PRIORIDADE_COLOR,
  PRIORIDADE_LABELS,
  TASK_TYPE_LABELS,
  TaskType,
} from './types';

const TYPE_ICON: Record<TaskType, typeof Phone> = {
  FOLLOW_UP: MessageCircle,
  LIGACAO: Phone,
  REUNIAO: Users,
  EMAIL: Mail,
  VISITA: MapPin,
  OUTRO: CircleDot,
};

export function TaskCard({
  task,
  onComplete,
  onEdit,
  onDelete,
}: {
  task: AgendaTask;
  onComplete?: (t: AgendaTask) => void;
  onEdit?: (t: AgendaTask) => void;
  onDelete?: (t: AgendaTask) => void;
}) {
  const Icon = TYPE_ICON[task.tipo];
  const when = new Date(task.scheduled_at);
  const done = task.status === 'CONCLUIDA';
  const overdue = task.status === 'ATRASADA';

  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-lg border border-border bg-card p-3 shadow-sm border-l-4',
        PRIORIDADE_COLOR[task.prioridade],
        done && 'opacity-60',
      )}
    >
      <div className="mt-0.5 flex h-8 w-8 items-center justify-center rounded-md bg-muted">
        <Icon className="h-4 w-4" />
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn('truncate font-semibold', done && 'line-through')}>{task.titulo}</span>
          <Badge className={cn('border-0', PRIORIDADE_BADGE[task.prioridade])}>
            {PRIORIDADE_LABELS[task.prioridade]}
          </Badge>
          <span className="text-xs text-muted-foreground">{TASK_TYPE_LABELS[task.tipo]}</span>
          {overdue && <Badge className="border-0 bg-destructive/15 text-destructive">Atrasada</Badge>}
        </div>

        {task.descricao && <p className="line-clamp-2 text-sm text-muted-foreground">{task.descricao}</p>}

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {format(when, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })}
          </span>
          {task.duracao_min ? <span>{task.duracao_min} min</span> : null}
          {task.lead ? (
            <Link href={`/chat/${task.lead.id}`} className="text-primary hover:underline">
              {task.lead.nome}
            </Link>
          ) : null}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1">
        {!done && (
          <Button
            size="icon"
            variant="ghost"
            className="h-8 w-8 text-green-600 hover:text-green-700"
            onClick={() => onComplete?.(task)}
            aria-label="Concluir"
          >
            <Check className="h-4 w-4" />
          </Button>
        )}
        <Button size="icon" variant="ghost" className="h-8 w-8" onClick={() => onEdit?.(task)} aria-label="Editar">
          <Pencil className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8 text-destructive"
          onClick={() => onDelete?.(task)}
          aria-label="Excluir"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
