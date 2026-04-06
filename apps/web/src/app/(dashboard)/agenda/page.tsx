'use client';

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { toast } from 'sonner';
import {
  addDays,
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  isSameDay,
  startOfDay,
  startOfMonth,
  startOfWeek,
} from 'date-fns';
import { ptBR } from 'date-fns/locale';

import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/cn';

import { TaskCard } from '@/components/agenda/task-card';
import { NewTaskDialog } from '@/components/agenda/new-task-dialog';
import { AgendaTask, PRIORIDADE_COLOR, Prioridade } from '@/components/agenda/types';

type ViewKey = 'today' | 'week' | 'month' | 'overdue';

export default function AgendaPage() {
  const qc = useQueryClient();
  const [view, setView] = useState<ViewKey>('today');
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AgendaTask | null>(null);

  const range = useMemo(() => {
    const now = new Date();
    if (view === 'today') return { from: startOfDay(now), to: endOfDay(now) };
    if (view === 'week') return { from: startOfWeek(now, { weekStartsOn: 0 }), to: endOfWeek(now, { weekStartsOn: 0 }) };
    if (view === 'month') return { from: startOfMonth(now), to: endOfMonth(now) };
    return null;
  }, [view]);

  const { data: tasks = [], isLoading } = useQuery<AgendaTask[]>({
    queryKey: ['tasks', view, range?.from?.toISOString(), range?.to?.toISOString()],
    queryFn: async () => {
      if (view === 'overdue') return (await api.get('/api/tasks/overdue')).data;
      const { data } = await api.get('/api/tasks', {
        params: {
          from: range!.from.toISOString(),
          to: range!.to.toISOString(),
        },
      });
      return data;
    },
  });

  useEffect(() => {
    const s = getSocket();
    const inv = () => qc.invalidateQueries({ queryKey: ['tasks'] });
    s.on('task:created', inv);
    s.on('task:updated', inv);
    s.on('task:overdue', inv);
    return () => {
      s.off('task:created', inv);
      s.off('task:updated', inv);
      s.off('task:overdue', inv);
    };
  }, [qc]);

  const completeMutation = useMutation({
    mutationFn: async (id: string) => (await api.post(`/api/tasks/${id}/complete`)).data,
    onSuccess: () => {
      toast.success('Tarefa concluída');
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => (await api.delete(`/api/tasks/${id}`)).data,
    onSuccess: () => {
      toast.success('Tarefa excluída');
      qc.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const handleNew = () => {
    setEditing(null);
    setDialogOpen(true);
  };
  const handleEdit = (t: AgendaTask) => {
    setEditing(t);
    setDialogOpen(true);
  };

  return (
    <div className="flex h-full flex-col gap-4 p-4 md:p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Agenda</h1>
          <p className="text-sm text-muted-foreground">Gerencie tarefas, follow-ups e lembretes</p>
        </div>
        <Button onClick={handleNew}>
          <Plus className="mr-2 h-4 w-4" /> Nova Tarefa
        </Button>
      </div>

      <Tabs value={view} onValueChange={(v) => setView(v as ViewKey)} className="flex flex-1 flex-col">
        <TabsList>
          <TabsTrigger value="today">Hoje</TabsTrigger>
          <TabsTrigger value="week">Semana</TabsTrigger>
          <TabsTrigger value="month">Mês</TabsTrigger>
          <TabsTrigger value="overdue">Atrasadas</TabsTrigger>
        </TabsList>

        <TabsContent value="today" className="flex-1">
          <TodayView
            tasks={tasks}
            loading={isLoading}
            onComplete={(t) => completeMutation.mutate(t.id)}
            onDelete={(t) => deleteMutation.mutate(t.id)}
            onEdit={handleEdit}
          />
        </TabsContent>
        <TabsContent value="week" className="flex-1">
          <WeekView tasks={tasks} loading={isLoading} onSelect={handleEdit} />
        </TabsContent>
        <TabsContent value="month" className="flex-1">
          <MonthView tasks={tasks} loading={isLoading} onSelect={handleEdit} />
        </TabsContent>
        <TabsContent value="overdue" className="flex-1">
          <OverdueView
            tasks={tasks}
            loading={isLoading}
            onComplete={(t) => completeMutation.mutate(t.id)}
            onDelete={(t) => deleteMutation.mutate(t.id)}
            onEdit={handleEdit}
          />
        </TabsContent>
      </Tabs>

      <NewTaskDialog open={dialogOpen} onOpenChange={setDialogOpen} task={editing} />
    </div>
  );
}

function SkeletonList() {
  return (
    <div className="space-y-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <Skeleton key={i} className="h-20 w-full" />
      ))}
    </div>
  );
}

function TodayView({
  tasks,
  loading,
  onComplete,
  onDelete,
  onEdit,
}: {
  tasks: AgendaTask[];
  loading: boolean;
  onComplete: (t: AgendaTask) => void;
  onDelete: (t: AgendaTask) => void;
  onEdit: (t: AgendaTask) => void;
}) {
  if (loading) return <SkeletonList />;
  if (tasks.length === 0) {
    return <Card className="p-6 text-center text-muted-foreground">Nenhuma tarefa para hoje</Card>;
  }
  const byHour = new Map<string, AgendaTask[]>();
  for (const t of tasks) {
    const h = format(new Date(t.scheduled_at), 'HH:00');
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h)!.push(t);
  }
  return (
    <ScrollArea className="h-full">
      <div className="space-y-4 pr-4">
        {[...byHour.entries()].map(([hour, items]) => (
          <div key={hour}>
            <div className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">{hour}</div>
            <div className="space-y-2">
              {items.map((t) => (
                <TaskCard key={t.id} task={t} onComplete={onComplete} onDelete={onDelete} onEdit={onEdit} />
              ))}
            </div>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

function OverdueView(props: Parameters<typeof TodayView>[0]) {
  if (props.loading) return <SkeletonList />;
  if (props.tasks.length === 0) {
    return <Card className="p-6 text-center text-muted-foreground">Sem tarefas atrasadas</Card>;
  }
  const sorted = [...props.tasks].sort(
    (a, b) => new Date(b.scheduled_at).getTime() - new Date(a.scheduled_at).getTime(),
  );
  return (
    <ScrollArea className="h-full">
      <div className="space-y-2 pr-4">
        {sorted.map((t) => (
          <TaskCard
            key={t.id}
            task={t}
            onComplete={props.onComplete}
            onDelete={props.onDelete}
            onEdit={props.onEdit}
          />
        ))}
      </div>
    </ScrollArea>
  );
}

function WeekView({
  tasks,
  loading,
  onSelect,
}: {
  tasks: AgendaTask[];
  loading: boolean;
  onSelect: (t: AgendaTask) => void;
}) {
  if (loading) return <SkeletonList />;
  const now = new Date();
  const start = startOfWeek(now, { weekStartsOn: 0 });
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <ScrollArea className="h-full">
      <div className="grid grid-cols-7 gap-2 pr-4">
        {days.map((d) => {
          const items = tasks.filter((t) => isSameDay(new Date(t.scheduled_at), d));
          return (
            <div key={d.toISOString()} className="flex min-h-[300px] flex-col rounded-md border border-border bg-card p-2">
              <div className="mb-2 text-xs font-semibold">
                {format(d, 'EEE dd', { locale: ptBR })}
              </div>
              <div className="space-y-1">
                {items.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => onSelect(t)}
                    className={cn(
                      'w-full truncate rounded border-l-4 bg-muted/30 px-2 py-1 text-left text-xs hover:bg-muted',
                      PRIORIDADE_COLOR[t.prioridade],
                    )}
                  >
                    <div className="font-medium">{format(new Date(t.scheduled_at), 'HH:mm')}</div>
                    <div className="truncate">{t.titulo}</div>
                  </button>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function MonthView({
  tasks,
  loading,
  onSelect,
}: {
  tasks: AgendaTask[];
  loading: boolean;
  onSelect: (t: AgendaTask) => void;
}) {
  if (loading) return <SkeletonList />;
  const now = new Date();
  const start = startOfWeek(startOfMonth(now), { weekStartsOn: 0 });
  const end = endOfWeek(endOfMonth(now), { weekStartsOn: 0 });
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);

  const priosByDay = new Map<string, Set<Prioridade>>();
  for (const t of tasks) {
    const key = format(new Date(t.scheduled_at), 'yyyy-MM-dd');
    if (!priosByDay.has(key)) priosByDay.set(key, new Set());
    priosByDay.get(key)!.add(t.prioridade);
  }

  const dotColor: Record<Prioridade, string> = {
    URGENTE: 'bg-destructive',
    ALTA: 'bg-amber-500',
    MEDIA: 'bg-primary',
    BAIXA: 'bg-muted-foreground',
  };

  return (
    <ScrollArea className="h-full">
      <div className="pr-4">
        <div className="mb-2 grid grid-cols-7 gap-1 text-center text-xs font-semibold text-muted-foreground">
          {['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'].map((d) => (
            <div key={d}>{d}</div>
          ))}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {days.map((d) => {
            const key = format(d, 'yyyy-MM-dd');
            const prios = priosByDay.get(key);
            const dayTasks = tasks.filter((t) => isSameDay(new Date(t.scheduled_at), d));
            const inMonth = d.getMonth() === now.getMonth();
            return (
              <div
                key={key}
                className={cn(
                  'min-h-[90px] rounded-md border border-border bg-card p-1.5 text-xs',
                  !inMonth && 'opacity-40',
                )}
              >
                <div className="mb-1 font-semibold">{format(d, 'd')}</div>
                {prios && (
                  <div className="mb-1 flex gap-0.5">
                    {[...prios].map((p) => (
                      <span key={p} className={cn('h-1.5 w-1.5 rounded-full', dotColor[p])} />
                    ))}
                  </div>
                )}
                <div className="space-y-0.5">
                  {dayTasks.slice(0, 2).map((t) => (
                    <button
                      key={t.id}
                      onClick={() => onSelect(t)}
                      className="block w-full truncate text-left hover:underline"
                    >
                      {format(new Date(t.scheduled_at), 'HH:mm')} {t.titulo}
                    </button>
                  ))}
                  {dayTasks.length > 2 && (
                    <div className="text-[10px] text-muted-foreground">+{dayTasks.length - 2}</div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </ScrollArea>
  );
}
