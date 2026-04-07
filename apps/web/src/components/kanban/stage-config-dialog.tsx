'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { api } from '@/lib/api';

interface TenantUser {
  id: string;
  nome: string;
  email: string;
  role: string;
}

const TASK_TYPES = ['FOLLOW_UP', 'LIGACAO', 'REUNIAO', 'EMAIL', 'VISITA', 'OUTRO'] as const;
type TaskType = (typeof TASK_TYPES)[number];

export interface StageAutoActionForm {
  on_enter?: {
    create_task?: { titulo: string; tipo: TaskType; offset_min: number };
    send_message?: { content: string };
    assign_user?: { user_id: string };
  };
}

export interface StageConfig {
  id: string;
  nome: string;
  cor: string;
  is_won: boolean;
  is_lost: boolean;
  max_dias: number | null;
  auto_action: StageAutoActionForm | null;
}

interface StageConfigDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  stage: StageConfig | null;
  isLoading?: boolean;
  onSubmit: (patch: {
    is_won: boolean;
    is_lost: boolean;
    max_dias: number | null;
    auto_action: StageAutoActionForm | null;
  }) => void;
}

export function StageConfigDialog({
  open,
  onOpenChange,
  stage,
  isLoading,
  onSubmit,
}: StageConfigDialogProps) {
  const { data: tenantUsers = [] } = useQuery<TenantUser[]>({
    queryKey: ['users'],
    queryFn: async () => {
      const res = await api.get('/api/users/list');
      return res.data;
    },
  });

  const [isWon, setIsWon] = useState(false);
  const [isLost, setIsLost] = useState(false);
  const [maxDias, setMaxDias] = useState('');
  const [taskOn, setTaskOn] = useState(false);
  const [taskTitulo, setTaskTitulo] = useState('');
  const [taskTipo, setTaskTipo] = useState<TaskType>('FOLLOW_UP');
  const [taskOffset, setTaskOffset] = useState('60');
  const [msgOn, setMsgOn] = useState(false);
  const [msgContent, setMsgContent] = useState('');
  const [assignOn, setAssignOn] = useState(false);
  const [assignUserId, setAssignUserId] = useState('');

  useEffect(() => {
    if (!open || !stage) return;
    setIsWon(stage.is_won);
    setIsLost(stage.is_lost);
    setMaxDias(stage.max_dias ? String(stage.max_dias) : '');
    const onEnter = stage.auto_action?.on_enter;
    setTaskOn(!!onEnter?.create_task);
    setTaskTitulo(onEnter?.create_task?.titulo ?? '');
    setTaskTipo(onEnter?.create_task?.tipo ?? 'FOLLOW_UP');
    setTaskOffset(String(onEnter?.create_task?.offset_min ?? 60));
    setMsgOn(!!onEnter?.send_message);
    setMsgContent(onEnter?.send_message?.content ?? '');
    setAssignOn(!!onEnter?.assign_user);
    setAssignUserId(onEnter?.assign_user?.user_id ?? '');
  }, [open, stage]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const onEnter: NonNullable<StageAutoActionForm['on_enter']> = {};
    if (taskOn && taskTitulo.trim()) {
      onEnter.create_task = {
        titulo: taskTitulo.trim(),
        tipo: taskTipo,
        offset_min: Math.max(0, parseInt(taskOffset || '0', 10) || 0),
      };
    }
    if (msgOn && msgContent.trim()) {
      onEnter.send_message = { content: msgContent.trim() };
    }
    if (assignOn && assignUserId.trim()) {
      onEnter.assign_user = { user_id: assignUserId.trim() };
    }
    const hasAny = Object.keys(onEnter).length > 0;
    onSubmit({
      is_won: isWon,
      is_lost: isLost,
      max_dias: maxDias ? Math.max(1, parseInt(maxDias, 10) || 0) : null,
      auto_action: hasAny ? { on_enter: onEnter } : null,
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Configurar etapa</DialogTitle>
          <DialogDescription>
            {stage ? <>Etapa <span className="font-semibold text-foreground">{stage.nome}</span></> : 'Etapa'}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="grid grid-cols-2 gap-3">
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="is-won" className="text-xs">Etapa de ganho</Label>
              <Switch id="is-won" checked={isWon} onCheckedChange={(v) => { setIsWon(v); if (v) setIsLost(false); }} />
            </div>
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <Label htmlFor="is-lost" className="text-xs">Etapa de perda</Label>
              <Switch id="is-lost" checked={isLost} onCheckedChange={(v) => { setIsLost(v); if (v) setIsWon(false); }} />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="max-dias">SLA: dias maximos na etapa</Label>
            <Input
              id="max-dias"
              type="number"
              min={1}
              value={maxDias}
              onChange={(e) => setMaxDias(e.target.value)}
              placeholder="Sem limite"
            />
            <p className="text-[11px] text-muted-foreground">
              Leads que excederem este prazo recebem alerta visual no card.
            </p>
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <p className="text-xs font-semibold uppercase text-muted-foreground">Acoes automaticas ao entrar</p>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="task-on" className="text-xs">Criar tarefa</Label>
                <Switch id="task-on" checked={taskOn} onCheckedChange={setTaskOn} />
              </div>
              {taskOn && (
                <div className="space-y-2 pl-1">
                  <Input
                    placeholder="Titulo da tarefa"
                    value={taskTitulo}
                    onChange={(e) => setTaskTitulo(e.target.value)}
                    className="h-8 text-xs"
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Select value={taskTipo} onValueChange={(v) => setTaskTipo(v as TaskType)}>
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {TASK_TYPES.map((t) => (
                          <SelectItem key={t} value={t}>{t}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Input
                      type="number"
                      min={0}
                      placeholder="Offset (min)"
                      value={taskOffset}
                      onChange={(e) => setTaskOffset(e.target.value)}
                      className="h-8 text-xs"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="msg-on" className="text-xs">Enviar mensagem</Label>
                <Switch id="msg-on" checked={msgOn} onCheckedChange={setMsgOn} />
              </div>
              {msgOn && (
                <Textarea
                  placeholder="Conteudo da mensagem"
                  value={msgContent}
                  onChange={(e) => setMsgContent(e.target.value)}
                  rows={3}
                  className="text-xs"
                />
              )}
            </div>

            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="assign-on" className="text-xs">Atribuir responsavel</Label>
                <Switch id="assign-on" checked={assignOn} onCheckedChange={setAssignOn} />
              </div>
              {assignOn && (
                <Select value={assignUserId} onValueChange={setAssignUserId}>
                  <SelectTrigger className="h-8 text-xs">
                    <SelectValue placeholder="Selecionar responsavel" />
                  </SelectTrigger>
                  <SelectContent>
                    {tenantUsers.map((u) => (
                      <SelectItem key={u.id} value={u.id}>{u.nome}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
              Cancelar
            </Button>
            <Button type="submit" disabled={isLoading}>
              {isLoading ? 'Salvando...' : 'Salvar'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
