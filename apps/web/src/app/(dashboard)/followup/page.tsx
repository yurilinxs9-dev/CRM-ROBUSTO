'use client';

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Play, Pause, X, Megaphone } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout/page-header';
import { ModelSelect } from '@/components/ai/model-select';

interface Stage { id: string; nome: string; cor?: string }
interface Pipeline { id: string; nome: string; stages: Stage[] }
interface Broadcast {
  id: string; name: string; mode: 'template' | 'ai'; status: string;
  throttle_seconds: number; stage_id: string | null;
  _count?: { targets: number }; target_counts?: Record<string, number>;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', running: 'Rodando', paused: 'Pausado', done: 'Concluído', canceled: 'Cancelado',
};
const STATUS_COLOR: Record<string, string> = {
  draft: '#6b7280', running: '#22c55e', paused: '#f59e0b', done: '#0ea5e9', canceled: '#ef4444',
};

export default function FollowupPage() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState('');
  const [mode, setMode] = useState<'template' | 'ai'>('ai');
  const [template, setTemplate] = useState('');
  const [aiInstruction, setAiInstruction] = useState('');
  const [modelId, setModelId] = useState<string | null>(null);
  const [throttleMin, setThrottleMin] = useState('5');
  const [respectAiBlock, setRespectAiBlock] = useState(true);

  const { data: broadcasts = [], isLoading } = useQuery<Broadcast[]>({
    queryKey: ['broadcasts'],
    queryFn: async () => (await api.get<Broadcast[]>('/api/broadcasts')).data,
    refetchInterval: 15_000, // acompanha o progresso enquanto roda
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => (await api.get<Pipeline[]>('/api/pipelines')).data,
    staleTime: 5 * 60_000,
  });

  const stages = pipelines.flatMap((p) => (p.stages ?? []).map((s) => ({ ...s, pipeline: p.nome })));

  function reset() {
    setName(''); setStageId(''); setMode('ai'); setTemplate(''); setAiInstruction('');
    setModelId(null); setThrottleMin('5'); setRespectAiBlock(true);
  }

  const create = useMutation({
    mutationFn: async () => api.post('/api/broadcasts', {
      name: name.trim(),
      stage_id: stageId || null,
      mode,
      template: mode === 'template' ? template.trim() : null,
      ai_instruction: mode === 'ai' ? aiInstruction.trim() : null,
      model_config_id: mode === 'ai' ? modelId : null,
      throttle_seconds: Math.max(30, Math.round(Number(throttleMin) * 60)),
      respect_ai_block: respectAiBlock,
    }),
    onSuccess: () => {
      toast.success('Follow-up criado (rascunho)');
      setOpen(false); reset();
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast.error(typeof msg === 'string' ? msg : 'Falha ao criar follow-up');
    },
  });

  const action = useMutation({
    mutationFn: async ({ id, op }: { id: string; op: 'start' | 'pause' | 'cancel' }) => api.post(`/api/broadcasts/${id}/${op}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['broadcasts'] }),
    onError: () => toast.error('Falha na ação'),
  });

  const valid = name.trim() && (mode === 'template' ? template.trim() : aiInstruction.trim());

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <PageHeader title="Follow-up IA" subtitle="Disparo por etapa com espaçamento e mensagens personalizadas por IA" />
        <Button onClick={() => setOpen(true)}><Plus className="mr-1.5 h-4 w-4" /> Novo follow-up</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>
      ) : broadcasts.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center" style={{ borderColor: 'var(--border-default)' }}>
          <Megaphone className="mx-auto h-8 w-8 mb-2" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>Nenhum follow-up criado.</p>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {broadcasts.map((b) => {
            const tc = b.target_counts ?? {};
            const total = b._count?.targets ?? Object.values(tc).reduce((a, n) => a + n, 0);
            const sent = tc.sent ?? 0;
            return (
              <div key={b.id} className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: STATUS_COLOR[b.status] }} />
                      <span className="font-medium text-sm truncate" style={{ color: 'var(--text-primary)' }}>{b.name}</span>
                    </div>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {STATUS_LABEL[b.status] ?? b.status} · {b.mode === 'ai' ? 'IA' : 'Template'} · {Math.round(b.throttle_seconds / 60)}min/msg
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {(b.status === 'draft' || b.status === 'paused') && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Iniciar" onClick={() => action.mutate({ id: b.id, op: 'start' })}><Play className="h-4 w-4 text-emerald-500" /></Button>
                    )}
                    {b.status === 'running' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Pausar" onClick={() => action.mutate({ id: b.id, op: 'pause' })}><Pause className="h-4 w-4 text-amber-500" /></Button>
                    )}
                    {b.status !== 'done' && b.status !== 'canceled' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Cancelar" onClick={() => { if (confirm('Cancelar follow-up?')) action.mutate({ id: b.id, op: 'cancel' }); }}><X className="h-4 w-4 text-red-500" /></Button>
                    )}
                  </div>
                </div>
                <div>
                  <div className="h-2 rounded-full overflow-hidden" style={{ background: 'var(--bg-surface-3)' }}>
                    <div className="h-full" style={{ width: total ? `${(sent / total) * 100}%` : '0%', background: 'var(--primary)' }} />
                  </div>
                  <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                    {sent}/{total} enviados{tc.skipped ? ` · ${tc.skipped} pulados` : ''}{tc.failed ? ` · ${tc.failed} falhas` : ''}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Dialog criar */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Novo follow-up</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Reativar leads frios" autoComplete="off" />
            </div>
            <div>
              <Label>Etapa do funil <span style={{ color: 'var(--text-muted)' }}>(vazio = todos os leads)</span></Label>
              <Select value={stageId} onValueChange={setStageId}>
                <SelectTrigger><SelectValue placeholder="Todas as etapas" /></SelectTrigger>
                <SelectContent>
                  {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.pipeline} · {s.nome}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label>Modo</Label>
              <Select value={mode} onValueChange={(v) => setMode(v as 'template' | 'ai')}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="ai">IA personaliza por lead</SelectItem>
                  <SelectItem value="template">Texto fixo (template)</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {mode === 'template' ? (
              <div>
                <Label>Mensagem (use {'{{nome}}'} e {'{{empresa}}'})</Label>
                <textarea value={template} onChange={(e) => setTemplate(e.target.value)} rows={3} placeholder="Oi {{nome}}, tudo bem? Passando p/ retomar nosso contato..."
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]" style={{ borderColor: 'var(--border-default)' }} />
              </div>
            ) : (
              <>
                <div>
                  <Label>Instrução p/ a IA</Label>
                  <textarea value={aiInstruction} onChange={(e) => setAiInstruction(e.target.value)} rows={3} placeholder="Ex: Reative o lead frio com tom amigável, lembre do interesse anterior e ofereça uma conversa rápida."
                    className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]" style={{ borderColor: 'var(--border-default)' }} />
                </div>
                <div>
                  <Label>Modelo <span style={{ color: 'var(--text-muted)' }}>(vazio = padrão)</span></Label>
                  <ModelSelect value={modelId} onChange={setModelId} placeholder="Modelo padrão" />
                </div>
              </>
            )}

            <div className="grid grid-cols-2 gap-3 items-end">
              <div>
                <Label>Intervalo entre msgs (min)</Label>
                <Input type="number" min="0.5" step="0.5" value={throttleMin} onChange={(e) => setThrottleMin(e.target.value)} />
              </div>
              <label className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
                <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Pular leads c/ IA bloqueada</span>
                <Switch checked={respectAiBlock} onCheckedChange={setRespectAiBlock} />
              </label>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>{create.isPending ? 'Criando...' : 'Criar follow-up'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
