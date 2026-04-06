'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';
import { AgendaTask, PRIORIDADE_LABELS, Prioridade, TASK_TYPE_LABELS, TaskType } from './types';

interface Lead {
  id: string;
  nome: string;
  telefone: string;
}

const TYPE_VALUES: TaskType[] = ['FOLLOW_UP', 'LIGACAO', 'REUNIAO', 'EMAIL', 'VISITA', 'OUTRO'];
const PRIO_VALUES: Prioridade[] = ['BAIXA', 'MEDIA', 'ALTA', 'URGENTE'];

export function NewTaskDialog({
  open,
  onOpenChange,
  task,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  task?: AgendaTask | null;
}) {
  const qc = useQueryClient();
  const isEdit = !!task;

  const [titulo, setTitulo] = useState('');
  const [descricao, setDescricao] = useState('');
  const [tipo, setTipo] = useState<TaskType>('FOLLOW_UP');
  const [prioridade, setPrioridade] = useState<Prioridade>('MEDIA');
  const [scheduledAt, setScheduledAt] = useState('');
  const [duracaoMin, setDuracaoMin] = useState<string>('');
  const [leadId, setLeadId] = useState<string>('');
  const [leadSearch, setLeadSearch] = useState('');
  const [leads, setLeads] = useState<Lead[]>([]);

  useEffect(() => {
    if (!open) return;
    if (task) {
      setTitulo(task.titulo);
      setDescricao(task.descricao ?? '');
      setTipo(task.tipo);
      setPrioridade(task.prioridade);
      setScheduledAt(new Date(task.scheduled_at).toISOString().slice(0, 16));
      setDuracaoMin(task.duracao_min?.toString() ?? '');
      setLeadId(task.lead_id ?? '');
    } else {
      setTitulo('');
      setDescricao('');
      setTipo('FOLLOW_UP');
      setPrioridade('MEDIA');
      const d = new Date();
      d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
      setScheduledAt(d.toISOString().slice(0, 16));
      setDuracaoMin('');
      setLeadId('');
    }
  }, [open, task]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(async () => {
      try {
        const { data } = await api.get('/api/leads', {
          params: { search: leadSearch || undefined, limit: '20' },
        });
        setLeads(data);
      } catch {
        /* ignore */
      }
    }, 250);
    return () => clearTimeout(t);
  }, [leadSearch, open]);

  const mutation = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        titulo,
        descricao: descricao || undefined,
        tipo,
        prioridade,
        scheduled_at: new Date(scheduledAt).toISOString(),
        duracao_min: duracaoMin ? parseInt(duracaoMin, 10) : undefined,
        lead_id: leadId || undefined,
      };
      if (isEdit && task) {
        return (await api.patch(`/api/tasks/${task.id}`, payload)).data;
      }
      return (await api.post('/api/tasks', payload)).data;
    },
    onSuccess: () => {
      toast.success(isEdit ? 'Tarefa atualizada' : 'Tarefa criada');
      qc.invalidateQueries({ queryKey: ['tasks'] });
      onOpenChange(false);
    },
    onError: () => toast.error('Erro ao salvar tarefa'),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Editar Tarefa' : 'Nova Tarefa'}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>Título</Label>
            <Input value={titulo} onChange={(e) => setTitulo(e.target.value)} placeholder="Ex: Ligar para cliente" />
          </div>

          <div className="space-y-1.5">
            <Label>Descrição</Label>
            <Textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              placeholder="Detalhes da tarefa"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Tipo</Label>
              <Select value={tipo} onValueChange={(v) => setTipo(v as TaskType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TYPE_VALUES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {TASK_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1.5">
              <Label>Prioridade</Label>
              <Select value={prioridade} onValueChange={(v) => setPrioridade(v as Prioridade)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PRIO_VALUES.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PRIORIDADE_LABELS[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label>Data e hora</Label>
              <Input type="datetime-local" value={scheduledAt} onChange={(e) => setScheduledAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label>Duração (min)</Label>
              <Input
                type="number"
                min={0}
                value={duracaoMin}
                onChange={(e) => setDuracaoMin(e.target.value)}
                placeholder="Ex: 30"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label>Lead vinculado</Label>
            <Input
              value={leadSearch}
              onChange={(e) => setLeadSearch(e.target.value)}
              placeholder="Buscar lead por nome/telefone"
            />
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger>
                <SelectValue placeholder="Nenhum" />
              </SelectTrigger>
              <SelectContent>
                {leads.map((l) => (
                  <SelectItem key={l.id} value={l.id}>
                    {l.nome} — {l.telefone}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancelar
          </Button>
          <Button onClick={() => mutation.mutate()} disabled={!titulo || !scheduledAt || mutation.isPending}>
            {mutation.isPending ? 'Salvando...' : 'Salvar'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
