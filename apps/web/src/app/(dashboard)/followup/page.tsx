'use client';

import { useEffect, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Play, Pause, X, Megaphone, Sparkles, FileText, Eye, Trash2, RotateCcw, AlertTriangle, Search, Send, MessageSquare, Clock } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout/page-header';
import { ModelSelect, useAvailableAiModels } from '@/components/ai/model-select';
import { estimateFinish } from '@/lib/followup-eta';
import { useAuthStore, useIsKanbanIndividual } from '@/stores/auth.store';

interface Stage { id: string; nome: string; cor?: string }
interface Pipeline { id: string; nome: string; stages: Stage[] }
interface Broadcast {
  id: string; name: string; mode: 'template' | 'ai'; status: string;
  throttle_seconds: number; daily_limit: number; stage_id: string | null;
  _count?: { targets: number }; target_counts?: Record<string, number>;
  sent_today?: number;
  /** Motivo da falha → quantos alvos. Vem agrupado da API. */
  failure_reasons?: Record<string, number>;
}
interface LeadOption { id: string; nome: string; telefone?: string | null }
interface Target {
  lead_id: string; nome: string; telefone: string | null;
  responsavel_nome: string | null; ai_blocked: boolean; status: string; error: string | null;
}
interface Preview { lead_nome: string; content: string }

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', running: 'Rodando', paused: 'Pausado', done: 'Concluído', canceled: 'Cancelado',
};
const STATUS_DOT: Record<string, string> = {
  draft: 'bg-ink-3', running: 'bg-success', paused: 'bg-warning', done: 'bg-info', canceled: 'bg-danger',
};
const ALL_STAGES = 'all';
const MANUAL = 'manual';

/** Variáveis do texto fixo — chips clicáveis que inserem no template. */
const TEMPLATE_VARS: { tag: string; hint: string }[] = [
  { tag: '{nome}', hint: 'nome completo' },
  { tag: '{primeiro_nome}', hint: 'primeiro nome' },
  { tag: '{saudacao}', hint: 'bom dia/boa tarde/boa noite' },
  { tag: '{empresa}', hint: 'empresa do lead' },
  { tag: '{telefone}', hint: 'telefone do lead' },
  { tag: '{atendente}', hint: 'responsável pelo lead' },
];

function apiError(e: unknown, fallback: string): string {
  const msg = (e as { response?: { data?: { message?: string } } })?.response?.data?.message;
  return typeof msg === 'string' ? msg : fallback;
}

export default function FollowupPage() {
  const qc = useQueryClient();
  const tenant = useAuthStore((s) => s.tenant);
  /**
   * O follow-up é disparado para a equipe inteira, então a etapa escolhida aqui
   * precisa ser a do MODELO BASE — com o kanban individual ligado, a lista sem
   * escopo traria as colunas pessoais do gestor, que ninguém mais tem. Só
   * gestor: o backend recusa `stage_scope=base` dos demais papéis.
   */
  const role = useAuthStore((s) => s.user?.role);
  const kanbanIndividual = useIsKanbanIndividual();
  const usaModeloBase =
    kanbanIndividual && (role === 'GERENTE' || role === 'SUPER_ADMIN');
  const pipelineParams: Record<string, string> = {};
  if (usaModeloBase) pipelineParams.stage_scope = 'base';
  const janela = {
    start: tenant?.broadcast_window_start ?? 9,
    end: tenant?.broadcast_window_end ?? 18,
    days: tenant?.broadcast_window_days ?? [1, 2, 3, 4, 5],
  };
  const [open, setOpen] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  // Cancelar/excluir usavam confirm() do navegador — bloqueia a aba e ignora o tema.
  const [cancelId, setCancelId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [stageId, setStageId] = useState(ALL_STAGES);
  const [mode, setMode] = useState<'template' | 'ai'>('ai');
  const [template, setTemplate] = useState('');
  const [aiInstruction, setAiInstruction] = useState('');
  const [modelId, setModelId] = useState<string | null>(null);
  const [throttleMin, setThrottleMin] = useState('15');
  const [dailyLimit, setDailyLimit] = useState('30');
  const [respectAiBlock, setRespectAiBlock] = useState(true);
  const [preview, setPreview] = useState<Preview | null>(null);
  // Envio separado: leads escolhidos a dedo
  const [leadSearch, setLeadSearch] = useState('');
  const [leadSearchDeb, setLeadSearchDeb] = useState('');
  const [selectedLeads, setSelectedLeads] = useState<LeadOption[]>([]);

  useEffect(() => {
    const t = setTimeout(() => setLeadSearchDeb(leadSearch.trim()), 300);
    return () => clearTimeout(t);
  }, [leadSearch]);

  const { data: leadResults = [], isFetching: leadSearchLoading } = useQuery<LeadOption[]>({
    queryKey: ['followup-lead-search', leadSearchDeb],
    queryFn: async () => {
      const { data } = await api.get('/api/leads', { params: { search: leadSearchDeb, limit: 8 } });
      const arr = Array.isArray(data) ? data : (data?.data ?? []);
      return arr as LeadOption[];
    },
    enabled: stageId === MANUAL && leadSearchDeb.length >= 2,
    staleTime: 10_000,
  });

  const { data: broadcasts = [], isLoading } = useQuery<Broadcast[]>({
    queryKey: ['broadcasts'],
    queryFn: async () => (await api.get<Broadcast[]>('/api/broadcasts')).data,
    refetchInterval: 15_000, // acompanha o progresso enquanto roda
  });

  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines', pipelineParams],
    queryFn: async () =>
      (await api.get<Pipeline[]>('/api/pipelines', { params: pipelineParams })).data,
    staleTime: 5 * 60_000,
  });

  const { data: aiModels = [], isLoading: aiModelsLoading } = useAvailableAiModels();
  const hasAiModel = aiModels.length > 0;

  const stages = pipelines.flatMap((p) => (p.stages ?? []).map((s) => ({ ...s, pipeline: p.nome })));

  function reset() {
    setName(''); setStageId(ALL_STAGES); setMode('ai'); setTemplate(''); setAiInstruction('');
    setModelId(null); setThrottleMin('15'); setDailyLimit('30'); setRespectAiBlock(true); setPreview(null);
    setLeadSearch(''); setSelectedLeads([]);
  }

  function createPayload() {
    return {
      stage_id: stageId === ALL_STAGES || stageId === MANUAL ? null : stageId,
      lead_ids: stageId === MANUAL ? selectedLeads.map((l) => l.id) : null,
      mode,
      template: mode === 'template' ? template.trim() : null,
      ai_instruction: mode === 'ai' ? aiInstruction.trim() : null,
      model_config_id: mode === 'ai' ? modelId : null,
    };
  }

  const create = useMutation({
    mutationFn: async () => api.post('/api/broadcasts', {
      name: name.trim(),
      ...createPayload(),
      throttle_seconds: Math.max(30, Math.round(Number(throttleMin) * 60)),
      daily_limit: Math.min(200, Math.max(1, Math.round(Number(dailyLimit) || 30))),
      respect_ai_block: respectAiBlock,
    }),
    onSuccess: () => {
      toast.success('Follow-up criado (rascunho) — aperte o Play pra disparar');
      setOpen(false); reset();
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Falha ao criar follow-up')),
  });

  const genPreview = useMutation({
    mutationFn: async () => (await api.post<Preview>('/api/broadcasts/preview', createPayload())).data,
    onSuccess: (p) => setPreview(p),
    onError: (e: unknown) => toast.error(apiError(e, 'Falha ao gerar exemplo')),
  });

  const action = useMutation({
    mutationFn: async ({ id, op }: { id: string; op: 'start' | 'pause' | 'cancel' | 'retry' }) =>
      api.post(`/api/broadcasts/${id}/${op}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['broadcasts'] }),
    onError: (e: unknown) => toast.error(apiError(e, 'Falha na ação')),
  });

  // Envio separado: dispara um lead específico agora, fora da cadência.
  const sendNow = useMutation({
    mutationFn: async ({ id, leadId }: { id: string; leadId: string }) =>
      (await api.post<{ sent: boolean; sent_today: number; daily_limit: number }>(`/api/broadcasts/${id}/send-now/${leadId}`)).data,
    onSuccess: (r) => {
      toast.success(`Enviado agora (${r.sent_today}/${r.daily_limit} hoje)`);
      qc.invalidateQueries({ queryKey: ['broadcasts'] });
      qc.invalidateQueries({ queryKey: ['broadcast-targets'] });
    },
    onError: (e: unknown) => toast.error(apiError(e, 'Falha no envio')),
  });

  const remove = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/broadcasts/${id}`),
    onSuccess: () => { toast.success('Follow-up excluído'); qc.invalidateQueries({ queryKey: ['broadcasts'] }); },
    onError: (e: unknown) => toast.error(apiError(e, 'Falha ao excluir')),
  });

  // Preview dos alvos antes do Play — busca quando há um broadcast em confirmação.
  const { data: previewTargets = [], isFetching: previewLoading } = useQuery<Target[]>({
    queryKey: ['broadcast-targets', confirmId],
    queryFn: async () => (await api.get<Target[]>(`/api/broadcasts/${confirmId}/targets`)).data,
    enabled: !!confirmId,
  });
  const confirmBroadcast = broadcasts.find((b) => b.id === confirmId) ?? null;
  const willSend = previewTargets.filter((t) => t.status === 'pending' && !t.ai_blocked);

  const targetsOk = stageId !== MANUAL || selectedLeads.length > 0;
  const valid = name.trim() && targetsOk && (mode === 'template' ? template.trim() : aiInstruction.trim() && hasAiModel);
  const previewable = (mode === 'template' ? !!template.trim() : !!aiInstruction.trim() && hasAiModel) && targetsOk;

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="flex items-center justify-between">
        <PageHeader title="Follow-up" subtitle="Disparo por etapa do funil — texto fixo ou mensagem personalizada por IA" />
        <Button onClick={() => { reset(); setOpen(true); }}><Plus className="mr-1.5 h-4 w-4" /> Novo follow-up</Button>
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>
      ) : broadcasts.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center" style={{ borderColor: 'var(--border-default)' }}>
          <Megaphone className="mx-auto h-8 w-8 mb-2" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>Nenhum follow-up criado ainda.</p>
          <Button variant="outline" onClick={() => { reset(); setOpen(true); }}><Plus className="mr-1.5 h-4 w-4" /> Criar o primeiro</Button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {broadcasts.map((b) => {
            const tc = b.target_counts ?? {};
            const total = b._count?.targets ?? Object.values(tc).reduce((a, n) => a + n, 0);
            // 'replied' é alvo que JÁ recebeu e respondeu — conta como enviado
            // na barra, senão o progresso andaria para trás quando o cliente responde.
            const replied = tc.replied ?? 0;
            const sent = (tc.sent ?? 0) + replied;
            const pending = tc.pending ?? 0;
            const failed = tc.failed ?? 0;
            const dailyLimit = b.daily_limit ?? 30;
            const sentToday = b.sent_today ?? 0;
            const deletable = b.status === 'draft' || b.status === 'done' || b.status === 'canceled';
            const eta =
              b.status === 'running'
                ? estimateFinish({
                    pending,
                    throttleSeconds: b.throttle_seconds,
                    dailyLimit,
                    sentToday,
                    janela,
                    agora: new Date(),
                  })
                : null;
            const reasons = Object.entries(b.failure_reasons ?? {}).sort((a, c) => c[1] - a[1]);
            return (
              <div key={b.id} className="rounded-xl border border-line-2 bg-surface-2 p-4 space-y-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`h-2 w-2 rounded-full shrink-0 ${STATUS_DOT[b.status] ?? 'bg-ink-3'}`} />
                      <span className="font-medium text-sm truncate text-ink-1">{b.name}</span>
                      <span className="inline-flex items-center gap-1 rounded-full border border-line-2 px-2 py-0.5 text-[10px] shrink-0 text-ink-2">
                        {b.mode === 'ai' ? <><Sparkles className="h-3 w-3" /> IA</> : <><FileText className="h-3 w-3" /> Texto fixo</>}
                      </span>
                    </div>
                    <p className="text-xs mt-0.5 text-ink-3">
                      {STATUS_LABEL[b.status] ?? b.status} · 1 msg a cada {Math.round(b.throttle_seconds / 60)}min
                      {' · '}hoje {sentToday}/{dailyLimit}
                      {b.status === 'running' && sentToday >= dailyLimit ? ' (limite do dia — retoma amanhã)' : ''}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0">
                    {(b.status === 'draft' || b.status === 'paused') && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Iniciar" onClick={() => setConfirmId(b.id)}><Play className="h-4 w-4 text-success" /></Button>
                    )}
                    {b.status === 'running' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Pausar" onClick={() => action.mutate({ id: b.id, op: 'pause' })}><Pause className="h-4 w-4 text-warning" /></Button>
                    )}
                    {failed > 0 && b.status !== 'running' && b.status !== 'canceled' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title={`Reenviar ${failed} falha(s)`} onClick={() => {
                        action.mutate({ id: b.id, op: 'retry' }, { onSuccess: () => toast.success(`${failed} alvo(s) de volta na fila`) });
                      }}><RotateCcw className="h-4 w-4 text-info" /></Button>
                    )}
                    {b.status !== 'done' && b.status !== 'canceled' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Cancelar" onClick={() => setCancelId(b.id)}><X className="h-4 w-4 text-danger" /></Button>
                    )}
                    {deletable && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Excluir" onClick={() => setDeleteId(b.id)}><Trash2 className="h-4 w-4 text-ink-3" /></Button>
                    )}
                  </div>
                </div>

                <div>
                  <div className="h-2 rounded-full overflow-hidden bg-surface-3 flex">
                    <div className="h-full bg-brand transition-all" style={{ width: total ? `${((sent - replied) / total) * 100}%` : '0%' }} />
                    <div className="h-full bg-success transition-all" style={{ width: total ? `${(replied / total) * 100}%` : '0%' }} />
                  </div>
                  <p className="text-[11px] mt-1 text-ink-3">
                    {sent}/{total} enviados{pending ? ` · ${pending} na fila` : ''}{tc.skipped ? ` · ${tc.skipped} pulados` : ''}
                  </p>
                </div>

                {/* Respostas: a única métrica que diz se o disparo virou conversa. */}
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${
                    replied > 0 ? 'bg-brand-subtle text-success border border-brand-border' : 'border border-line-2 text-ink-3'
                  }`}>
                    <MessageSquare className="h-3.5 w-3.5" />
                    {replied} {replied === 1 ? 'resposta' : 'respostas'}
                    {sent > 0 && replied > 0 ? <span className="text-ink-3 font-normal">({Math.round((replied / sent) * 100)}%)</span> : null}
                  </span>
                  {eta && (
                    <span
                      className={`inline-flex items-center gap-1.5 text-[11px] ${eta.paused ? 'text-warning' : 'text-ink-3'}`}
                      title={`${pending} na fila, 1 a cada ${Math.round(b.throttle_seconds / 60)}min, limite ${dailyLimit}/dia, janela ${janela.start}h–${janela.end}h`}
                    >
                      <Clock className="h-3.5 w-3.5" />
                      {eta.paused ? eta.label : eta.label.startsWith('termina') ? eta.label : `termina em ${eta.label}`}
                    </span>
                  )}
                </div>

                {/* Falhas COM o motivo: "3 falhas" não diz se é instância caída
                    ou cadastro sem telefone — e a correção é oposta nos dois casos. */}
                {failed > 0 && (
                  <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2">
                    <p className="text-xs font-medium text-danger">{failed} falha(s)</p>
                    <ul className="mt-1 space-y-0.5">
                      {reasons.slice(0, 3).map(([motivo, qtd]) => (
                        <li key={motivo} className="text-[11px] text-ink-2 flex gap-1.5">
                          <span className="text-ink-3 shrink-0">{qtd}×</span>
                          <span className="truncate" title={motivo}>{motivo}</span>
                        </li>
                      ))}
                      {reasons.length > 3 && (
                        <li className="text-[11px] text-ink-3">+{reasons.length - 3} outro(s) motivo(s)</li>
                      )}
                    </ul>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Dialog criar */}
      <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader><DialogTitle>Novo follow-up</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div>
              <Label>Nome</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex: Reativar leads frios" autoComplete="off" />
            </div>

            <div>
              <Label>Quem recebe</Label>
              <Select value={stageId} onValueChange={(v) => { setStageId(v); setPreview(null); }}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_STAGES}>Todos os leads (todas as etapas)</SelectItem>
                  <SelectItem value={MANUAL}>Leads específicos (escolher um a um)</SelectItem>
                  {stages.map((s) => <SelectItem key={s.id} value={s.id}>{s.pipeline} · {s.nome}</SelectItem>)}
                </SelectContent>
              </Select>
              {stageId === MANUAL && (
                <div className="mt-2 space-y-2">
                  <div className="relative">
                    <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2" style={{ color: 'var(--text-muted)' }} />
                    <Input className="pl-8" value={leadSearch} onChange={(e) => setLeadSearch(e.target.value)} placeholder="Buscar lead por nome ou telefone..." autoComplete="off" />
                  </div>
                  {leadSearchDeb.length >= 2 && (
                    <div className="rounded-md border divide-y max-h-40 overflow-y-auto" style={{ borderColor: 'var(--border-default)' }}>
                      {leadSearchLoading ? (
                        <p className="p-2 text-xs" style={{ color: 'var(--text-muted)' }}>Buscando...</p>
                      ) : leadResults.filter((l) => !selectedLeads.some((s) => s.id === l.id)).length === 0 ? (
                        <p className="p-2 text-xs" style={{ color: 'var(--text-muted)' }}>Nenhum lead encontrado.</p>
                      ) : (
                        leadResults.filter((l) => !selectedLeads.some((s) => s.id === l.id)).map((l) => (
                          <button key={l.id} type="button" className="flex w-full items-center justify-between gap-2 p-2 text-left text-sm hover:opacity-80"
                            onClick={() => { setSelectedLeads((prev) => [...prev, l]); setLeadSearch(''); }}>
                            <span className="truncate" style={{ color: 'var(--text-primary)' }}>{l.nome}</span>
                            <span className="text-[11px] shrink-0" style={{ color: 'var(--text-muted)' }}>{l.telefone ?? ''}</span>
                          </button>
                        ))
                      )}
                    </div>
                  )}
                  {selectedLeads.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {selectedLeads.map((l) => (
                        <span key={l.id} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]"
                          style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                          {l.nome}
                          <button type="button" onClick={() => setSelectedLeads((prev) => prev.filter((x) => x.id !== l.id))} aria-label={`Remover ${l.nome}`}>
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ))}
                    </div>
                  )}
                  <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>
                    {selectedLeads.length} lead(s) selecionado(s) — envio separado, só pra esses.
                  </p>
                </div>
              )}
            </div>

            {/* Modo: dois cartões clicáveis — mais claro que um select */}
            <div>
              <Label>Mensagem</Label>
              <div className="grid grid-cols-2 gap-2 mt-1">
                {([
                  { key: 'ai' as const, icon: Sparkles, title: 'IA personaliza', desc: 'Uma mensagem única por lead' },
                  { key: 'template' as const, icon: FileText, title: 'Texto fixo', desc: 'Mesmo texto pra todos' },
                ]).map(({ key, icon: Icon, title, desc }) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => { setMode(key); setPreview(null); }}
                    className="rounded-lg border p-3 text-left transition-colors"
                    style={{
                      borderColor: mode === key ? 'var(--primary)' : 'var(--border-default)',
                      background: mode === key ? 'color-mix(in srgb, var(--primary) 8%, transparent)' : 'transparent',
                    }}
                  >
                    <Icon className="h-4 w-4 mb-1" style={{ color: mode === key ? 'var(--primary)' : 'var(--text-muted)' }} />
                    <p className="text-sm font-medium" style={{ color: 'var(--text-primary)' }}>{title}</p>
                    <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{desc}</p>
                  </button>
                ))}
              </div>
            </div>

            {mode === 'template' ? (
              <div>
                <Label>Texto da mensagem</Label>
                <textarea value={template} onChange={(e) => { setTemplate(e.target.value); setPreview(null); }} rows={3} placeholder="{saudacao} {primeiro_nome}, tudo bem? Passando p/ retomar nosso contato..."
                  className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]" style={{ borderColor: 'var(--border-default)' }} />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {TEMPLATE_VARS.map((v) => (
                    <button key={v.tag} type="button" title={v.hint}
                      onClick={() => { setTemplate((t) => `${t}${t && !t.endsWith(' ') ? ' ' : ''}${v.tag}`); setPreview(null); }}
                      className="rounded-full border px-2 py-0.5 text-[11px] font-mono hover:opacity-80"
                      style={{ borderColor: 'var(--border-default)', color: 'var(--text-secondary)' }}>
                      {v.tag}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>
                  Clique pra inserir — cada variável é trocada pelos dados do lead na hora do envio.
                </p>
              </div>
            ) : !aiModelsLoading && !hasAiModel ? (
              <div className="flex items-start gap-2 rounded-lg border p-3 text-sm" style={{ borderColor: '#f59e0b', background: 'color-mix(in srgb, #f59e0b 10%, transparent)' }}>
                <AlertTriangle className="h-4 w-4 mt-0.5 shrink-0 text-amber-500" />
                <div style={{ color: 'var(--text-secondary)' }}>
                  <p className="font-medium" style={{ color: 'var(--text-primary)' }}>Nenhum modelo de IA configurado</p>
                  <p className="text-xs mt-0.5">O admin da plataforma precisa cadastrar um modelo em <strong>Admin → IA</strong>. Enquanto isso, use o modo <strong>Texto fixo</strong>.</p>
                </div>
              </div>
            ) : (
              <>
                <div>
                  <Label>O que a IA deve dizer</Label>
                  <textarea value={aiInstruction} onChange={(e) => { setAiInstruction(e.target.value); setPreview(null); }} rows={3} placeholder="Ex: Reative o lead frio com tom amigável, lembre do interesse anterior e ofereça uma conversa rápida."
                    className="w-full rounded-md border bg-transparent px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)]" style={{ borderColor: 'var(--border-default)' }} />
                </div>
                <div>
                  <Label>Modelo <span style={{ color: 'var(--text-muted)' }}>(vazio = padrão da plataforma)</span></Label>
                  <ModelSelect value={modelId} onChange={setModelId} placeholder="Modelo padrão" />
                </div>
              </>
            )}

            {/* Preview real: gera a mensagem pra um lead do segmento, sem enviar */}
            <div className="space-y-2">
              <Button type="button" variant="outline" size="sm" disabled={!previewable || genPreview.isPending} onClick={() => genPreview.mutate()}>
                <Eye className="mr-1.5 h-3.5 w-3.5" />
                {genPreview.isPending ? 'Gerando exemplo...' : 'Ver exemplo da mensagem'}
              </Button>
              {preview && (
                <div className="rounded-lg border p-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-3)' }}>
                  <p className="text-[11px] mb-1" style={{ color: 'var(--text-muted)' }}>Exemplo pra <strong>{preview.lead_nome}</strong>:</p>
                  <p className="text-sm whitespace-pre-wrap" style={{ color: 'var(--text-primary)' }}>{preview.content}</p>
                </div>
              )}
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Intervalo entre msgs (min)</Label>
                <Input type="number" min="0.5" step="0.5" value={throttleMin} onChange={(e) => setThrottleMin(e.target.value)} />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Padrão: 15 min</p>
              </div>
              <div>
                <Label>Limite diário de envios</Label>
                <Input type="number" min="1" max="200" value={dailyLimit} onChange={(e) => setDailyLimit(e.target.value)} />
                <p className="text-[11px] mt-1" style={{ color: 'var(--text-muted)' }}>Padrão: 30/dia — retoma sozinho no dia seguinte</p>
              </div>
            </div>
            <label className="flex items-center justify-between rounded-lg border px-3 py-2" style={{ borderColor: 'var(--border-default)' }}>
              <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>Pular leads em atendimento humano</span>
              <Switch checked={respectAiBlock} onCheckedChange={setRespectAiBlock} />
            </label>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancelar</Button>
            <Button onClick={() => create.mutate()} disabled={!valid || create.isPending}>{create.isPending ? 'Criando...' : 'Criar follow-up'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirmação antes do Play — mostra exatamente quais leads serão atingidos */}
      <Dialog open={!!confirmId} onOpenChange={(o) => { if (!o) setConfirmId(null); }}>
        <DialogContent className="max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader><DialogTitle>Disparar &quot;{confirmBroadcast?.name}&quot;?</DialogTitle></DialogHeader>
          {previewLoading ? (
            <div className="space-y-2 py-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}</div>
          ) : (
            <>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Vai enviar para <strong style={{ color: 'var(--text-primary)' }}>{willSend.length}</strong> lead(s)
                {previewTargets.length !== willSend.length && (
                  <span style={{ color: 'var(--text-muted)' }}> · {previewTargets.length - willSend.length} pulado(s)</span>
                )}:
              </p>
              <div className="overflow-y-auto -mx-2 px-2 divide-y" style={{ borderColor: 'var(--border-default)' }}>
                {previewTargets.map((t) => {
                  const skip = t.status !== 'pending' || t.ai_blocked;
                  // Alvo que já respondeu não está mais na fila: o backend
                  // recusa o envio manual com 400, então nem oferece o botão.
                  const canSendNow = t.status !== 'sent' && t.status !== 'replied';
                  return (
                    <div key={t.lead_id} className="flex items-center justify-between gap-2 py-2 text-sm" style={{ opacity: skip ? 0.5 : 1 }}>
                      <div className="min-w-0">
                        <p className="truncate" style={{ color: 'var(--text-primary)' }}>{t.nome}</p>
                        <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {t.responsavel_nome ? `Dono: ${t.responsavel_nome}` : 'Sem dono'}{t.telefone ? ` · ${t.telefone}` : ''}
                        </p>
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[11px] text-right" style={{ color: t.status === 'failed' ? '#ef4444' : 'var(--text-muted)' }} title={t.error ?? undefined}>
                          {t.status === 'sent' ? 'já enviado'
                            : t.status === 'replied' ? 'respondeu'
                            : t.status === 'failed' ? 'falhou'
                            : t.status === 'skipped' ? 'pulado'
                            : t.ai_blocked ? 'em atendimento'
                            : t.status === 'pending' ? '' : t.status}
                        </span>
                        {canSendNow && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Enviar agora (fora da fila)"
                            disabled={sendNow.isPending}
                            onClick={() => { if (confirmId) sendNow.mutate({ id: confirmId, leadId: t.lead_id }); }}>
                            <Send className="h-3.5 w-3.5" style={{ color: 'var(--primary)' }} />
                          </Button>
                        )}
                      </div>
                    </div>
                  );
                })}
                {previewTargets.length === 0 && (
                  <p className="py-4 text-sm text-center" style={{ color: 'var(--text-muted)' }}>Nenhum lead nessa segmentação.</p>
                )}
              </div>
            </>
          )}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmId(null)}>Cancelar</Button>
            <Button
              disabled={previewLoading || willSend.length === 0 || action.isPending}
              onClick={() => {
                if (!confirmId) return;
                action.mutate({ id: confirmId, op: 'start' }, {
                  onSuccess: () => { toast.success('Follow-up iniciado'); setConfirmId(null); },
                });
              }}
            >
              {action.isPending ? 'Iniciando...' : `Confirmar e disparar (${willSend.length})`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelId} onOpenChange={(o) => { if (!o) setCancelId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancelar follow-up?</DialogTitle></DialogHeader>
          <p className="text-sm text-ink-2">
            Os alvos que ainda não receberam ficam de fora. O histórico do que já foi enviado permanece.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCancelId(null)}>Voltar</Button>
            <Button
              variant="destructive"
              disabled={action.isPending}
              onClick={() => {
                if (!cancelId) return;
                action.mutate({ id: cancelId, op: 'cancel' }, { onSuccess: () => setCancelId(null) });
              }}
            >
              {action.isPending ? 'Cancelando...' : 'Cancelar disparo'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!deleteId} onOpenChange={(o) => { if (!o) setDeleteId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Excluir follow-up?</DialogTitle></DialogHeader>
          <p className="text-sm text-ink-2">
            O histórico dos alvos — quem recebeu, quem respondeu, quem falhou — some junto. Não dá pra desfazer.
          </p>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleteId(null)}>Voltar</Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => {
                if (!deleteId) return;
                remove.mutate(deleteId, { onSuccess: () => setDeleteId(null) });
              }}
            >
              {remove.isPending ? 'Excluindo...' : 'Excluir'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
