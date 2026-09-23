'use client';

import { useState } from 'react';
import { CampaignEditor, type CampaignConfig } from './campaign-editor';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Plus, Play, Pause, X, Megaphone, Sparkles, FileText, Eye, Trash2, RotateCcw, AlertTriangle, Search, Send, MessageSquare, Clock, Copy, Pencil, ShieldCheck, ArrowUpRight, Users } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { PageHeader } from '@/components/layout/page-header';
import { estimateFinish } from '@/lib/followup-eta';
import { useAuthStore, useIsKanbanIndividual } from '@/stores/auth.store';

interface Stage { id: string; nome: string; cor?: string }
interface Pipeline { id: string; nome: string; stages: Stage[] }
interface Broadcast extends CampaignConfig {
  id: string; name: string; mode: 'template' | 'ai'; status: string;
  throttle_seconds: number; daily_limit: number; stage_id: string | null;
  _count?: { targets: number }; target_counts?: Record<string, number>;
  sent_today?: number; attempts_today?: number;
  /** Motivo da falha → quantos alvos. Vem agrupado da API. */
  failure_reasons?: Record<string, number>;
}
interface Target {
  lead_id: string; nome: string; telefone: string | null;
  responsavel_nome: string | null; ai_blocked: boolean; status: string; error: string | null; sent_at?: string | null; replied_at?: string | null; error_code?: string | null;
}

const STATUS_LABEL: Record<string, string> = {
  draft: 'Rascunho', running: 'Rodando', paused: 'Pausado', done: 'Concluído', canceled: 'Cancelado',
};
const STATUS_DOT: Record<string, string> = {
  draft: 'bg-ink-3', running: 'bg-success', paused: 'bg-warning', done: 'bg-info', canceled: 'bg-danger',
};
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
  const [editing, setEditing] = useState<Broadcast | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [detailsOnly, setDetailsOnly] = useState(false);
  const [targetSearch, setTargetSearch] = useState('');
  const [targetFilter, setTargetFilter] = useState('all');

  const { data: broadcasts = [], isLoading, isError, refetch } = useQuery<Broadcast[]>({
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

  const action = useMutation({
    mutationFn: async ({ id, op }: { id: string; op: 'start' | 'pause' | 'cancel' | 'retry' | 'duplicate' }) =>
      api.post(`/api/broadcasts/${id}/${op}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['broadcasts'] }),
    onError: (e: unknown) => toast.error(apiError(e, 'Falha na ação')),
  });

  // Envio separado: dispara um lead específico agora, fora da cadência.
  const sendNow = useMutation({
    mutationFn: async ({ id, leadId }: { id: string; leadId: string }) =>
      (await api.post<{ sent: boolean; sent_today: number; daily_limit: number }>(`/api/broadcasts/${id}/send-now/${leadId}`)).data,
    onSuccess: (r) => {
      toast.success(`Mensagem encaminhada (${r.sent_today}/${r.daily_limit} hoje)`);
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

  const visible = broadcasts.filter(b => (!search || b.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && (statusFilter === 'all' || b.status === statusFilter));
  const metrics = broadcasts.reduce((m,b) => ({ today: m.today+(b.sent_today??0), pending: m.pending+(b.target_counts?.pending??0), replied: m.replied+(b.target_counts?.replied??0), failed: m.failed+(b.target_counts?.failed??0) }), { today:0,pending:0,replied:0,failed:0 });
  function showDetails(id: string, readOnly = true) { setConfirmId(id); setDetailsOnly(readOnly); setTargetSearch(''); setTargetFilter('all'); }
  const filteredTargets = previewTargets.filter(t => (targetFilter==='all'||t.status===targetFilter) && `${t.nome} ${t.telefone??''} ${t.responsavel_nome??''}`.toLocaleLowerCase().includes(targetSearch.toLocaleLowerCase()));

  return (
    <div className="p-4 sm:p-6 space-y-5">
      <div className="rounded-2xl border border-brand-border bg-gradient-to-br from-brand-subtle to-surface-2 p-5 sm:p-7">
        <div className="flex flex-wrap gap-4 items-center justify-between">
          <div><p className="text-[10px] uppercase tracking-[.2em] text-brand font-semibold mb-2">RELACIONAMENTO QUE CONTINUA</p><PageHeader title="Central de Follow-up" subtitle="O público certo, no momento certo. Organize campanhas e acompanhe cada conversa." /></div>
          <Button onClick={() => { setEditing(null); setOpen(true); }}><Plus className="mr-1.5 h-4 w-4" /> Nova campanha</Button>
        </div>
        <div className="mt-5 flex flex-wrap gap-3 text-xs text-ink-2"><span className="inline-flex items-center gap-1.5"><ShieldCheck className="h-4 w-4 text-brand"/>Limites e intervalos protegidos</span><span>Horário da empresa: {janela.start}h–{janela.end}h · Brasília</span><a href="/settings" className="text-brand underline">Ajustar horário da empresa</a></div>
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">{[
        {label:'Encaminhados hoje',value:metrics.today,icon:Send}, {label:'Contatos na fila',value:metrics.pending,icon:Users},
        {label:'Respostas registradas',value:metrics.replied,icon:MessageSquare}, {label:'Precisam de atenção',value:metrics.failed,icon:AlertTriangle},
      ].map(({label,value,icon:Icon})=><div key={label} className="rounded-xl border border-line-2 bg-surface-2 p-4"><div className="flex justify-between text-ink-3 text-xs">{label}<Icon className="h-4 w-4"/></div><p className="text-3xl font-semibold mt-3 text-ink-1">{value}</p></div>)}</div>
      <div className="flex flex-wrap gap-3 items-center"><div className="relative flex-1 min-w-48"><Search className="absolute left-3 top-3 h-4 w-4 text-ink-3"/><Input aria-label="Buscar campanhas" className="pl-9" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar campanha..."/></div><Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-44"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="all">Todos os status</SelectItem>{Object.entries(STATUS_LABEL).map(([v,l])=><SelectItem key={v} value={v}>{l}</SelectItem>)}</SelectContent></Select><Button variant="outline" onClick={()=>refetch()} title="Atualizar campanhas"><RotateCcw className="h-4 w-4"/></Button></div>
      {isError && <div role="alert" className="rounded-xl border border-danger p-4 text-sm text-danger">Não foi possível carregar as campanhas. <button onClick={()=>refetch()} className="underline">Tentar novamente</button></div>}
      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-lg" />)}</div>
      ) : !isError && visible.length === 0 ? (
        <div className="rounded-xl border border-dashed p-10 text-center" style={{ borderColor: 'var(--border-default)' }}>
          <Megaphone className="mx-auto h-8 w-8 mb-2" style={{ color: 'var(--text-muted)' }} />
          <p className="text-sm mb-3" style={{ color: 'var(--text-muted)' }}>Nenhuma campanha encontrada. Crie uma campanha ou ajuste os filtros.</p>
          <Button variant="outline" onClick={() => { setEditing(null); setOpen(true); }}><Plus className="mr-1.5 h-4 w-4" /> Criar o primeiro</Button>
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {visible.map((b) => {
            const tc = b.target_counts ?? {};
            const total = b._count?.targets ?? Object.values(tc).reduce((a, n) => a + n, 0);
            // 'replied' é alvo que JÁ recebeu e respondeu — conta como enviado
            // na barra, senão o progresso andaria para trás quando o cliente responde.
            const replied = tc.replied ?? 0;
            const sent = (tc.sent ?? 0) + replied;
            const pending = tc.pending ?? 0;
            const failed = tc.failed ?? 0;
            const dailyLimit = b.daily_limit ?? 30;
            const sentToday = b.attempts_today ?? b.sent_today ?? 0;
            const deletable = b.status === 'draft' || b.status === 'done' || b.status === 'canceled';
            const eta =
              b.status === 'running' && (!b.segment?.scheduled_at || new Date(b.segment.scheduled_at) <= new Date())
                ? estimateFinish({
                    pending,
                    throttleSeconds: b.throttle_seconds,
                    dailyLimit,
                    sentToday,
                    janela: { start: Math.max(janela.start,b.segment?.window_start??0), end: Math.min(janela.end,b.segment?.window_end??24), days: janela.days.filter(d=>!b.segment?.window_days||b.segment.window_days.includes(d)) },
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
                      {' · '}tentativas hoje {sentToday}/{dailyLimit}
                      {b.status === 'running' && sentToday >= dailyLimit ? ' (limite do dia — retoma amanhã)' : ''}
                    </p>
                  </div>
                  <div className="flex gap-1 shrink-0 flex-wrap justify-end">
                    {b.status==='draft'&&<Button size="icon" variant="ghost" className="h-8 w-8" title="Editar rascunho" onClick={()=>{setEditing(b);setOpen(true);}}><Pencil className="h-4 w-4"/></Button>}
                    <Button size="icon" variant="ghost" className="h-8 w-8" title="Duplicar como rascunho" disabled={action.isPending} onClick={()=>action.mutate({id:b.id,op:'duplicate'},{onSuccess:()=>toast.success('Cópia criada como rascunho')})}><Copy className="h-4 w-4"/></Button>
                    {(b.status === 'draft' || b.status === 'paused') && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Iniciar" onClick={() => showDetails(b.id, false)}><Play className="h-4 w-4 text-success" /></Button>
                    )}
                    {b.status === 'running' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title="Pausar" onClick={() => action.mutate({ id: b.id, op: 'pause' })}><Pause className="h-4 w-4 text-warning" /></Button>
                    )}
                    {failed > 0 && b.status !== 'running' && b.status !== 'canceled' && (
                      <Button size="icon" variant="ghost" className="h-8 w-8" title={`Reenviar ${failed} falha(s)`} onClick={() => {
                        action.mutate({ id: b.id, op: 'retry' }, { onSuccess: () => toast.success('Falhas disponíveis recolocadas na fila') });
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

                {b.segment?.scheduled_at && <p className="text-xs text-ink-3">Programado a partir de {new Date(b.segment.scheduled_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}</p>}
                <div>
                  <div className="h-2 rounded-full overflow-hidden bg-surface-3 flex">
                    <div className="h-full bg-brand transition-all" style={{ width: total ? `${((sent - replied) / total) * 100}%` : '0%' }} />
                    <div className="h-full bg-success transition-all" style={{ width: total ? `${(replied / total) * 100}%` : '0%' }} />
                  </div>
                  <p className="text-[11px] mt-1 text-ink-3">
                    {sent}/{total} encaminhados{pending ? ` · ${pending} na fila` : ''}{tc.skipped ? ` · ${tc.skipped} pulados` : ''}
                  </p>
                </div>

                <button onClick={()=>showDetails(b.id)} className="w-full flex items-center justify-between text-xs text-brand border-t border-line-2 pt-3">Ver destinatários e histórico<ArrowUpRight className="h-4 w-4"/></button>
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
                      title={`Previsão aproximada; outras campanhas podem ampliar o prazo. ${pending} na fila, 1 a cada ${Math.round(b.throttle_seconds / 60)}min, limite ${dailyLimit}/dia, janela ${janela.start}h–${janela.end}h`}
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

      <CampaignEditor open={open} onClose={()=>{setOpen(false);setEditing(null);}} initial={editing} pipelines={pipelines} window={janela}/>

      {/* Confirmação antes do Play — mostra exatamente quais leads serão atingidos */}
      <Dialog open={!!confirmId} onOpenChange={(o) => { if (!o) setConfirmId(null); }}>
        <DialogContent className="max-h-[85vh] overflow-hidden flex flex-col">
          <DialogHeader><DialogTitle>{detailsOnly ? 'Histórico: ' : 'Iniciar: '}{confirmBroadcast?.name}</DialogTitle></DialogHeader>
          {previewLoading ? (
            <div className="space-y-2 py-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-9 w-full rounded-md" />)}</div>
          ) : (
            <>
              <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
                Na fila para envio: <strong style={{ color: 'var(--text-primary)' }}>{willSend.length}</strong> lead(s)
                {previewTargets.length !== willSend.length && (
                  <span style={{ color: 'var(--text-muted)' }}> · {previewTargets.length} contatos no histórico</span>
                )}:
              </p>
              <div className="flex gap-2"><Input aria-label="Buscar destinatário" value={targetSearch} onChange={e=>setTargetSearch(e.target.value)} placeholder="Nome, telefone ou responsável"/><select aria-label="Status do destinatário" value={targetFilter} onChange={e=>setTargetFilter(e.target.value)} className="rounded border border-line-2 bg-surface-2 text-sm px-2"><option value="all">Todos</option><option value="pending">Na fila</option><option value="sent">Encaminhados</option><option value="replied">Responderam</option><option value="failed">Falhas</option><option value="skipped">Ignorados</option></select></div>
              <p className="text-xs text-ink-3">Envios seguem limite diário, intervalo e horários. Encaminhado significa inserido na fila de mensagens; a entrega é acompanhada na conversa.</p>
              <div className="overflow-y-auto -mx-2 px-2 divide-y" style={{ borderColor: 'var(--border-default)' }}>
                {filteredTargets.map((t) => {
                  const skip = t.status !== 'pending' || t.ai_blocked;
                  // Alvo que já respondeu não está mais na fila: o backend
                  // recusa o envio manual com 400, então nem oferece o botão.
                  const canSendNow = t.status === 'pending' && t.error_code !== 'dispatching' && !t.ai_blocked && confirmBroadcast?.status === 'running';
                  return (
                    <div key={t.lead_id} className="flex items-center justify-between gap-2 py-2 text-sm" style={{ opacity: skip ? 0.5 : 1 }}>
                      <div className="min-w-0">
                        <p className="truncate" style={{ color: 'var(--text-primary)' }}>{t.nome}</p>
                        <p className="text-[11px] truncate" style={{ color: 'var(--text-muted)' }}>
                          {t.responsavel_nome ? `Dono: ${t.responsavel_nome}` : 'Sem dono'}{t.telefone ? ` · ${t.telefone}` : ''}{t.sent_at ? ` · ${new Date(t.sent_at).toLocaleString('pt-BR',{timeZone:'America/Sao_Paulo'})}` : ''}
                        </p>
                        {t.error&&<p className="text-xs text-warning mt-1">{t.error}</p>}
                      </div>
                      <div className="flex items-center gap-1 shrink-0">
                        <span className="text-[11px] text-right" style={{ color: t.status === 'failed' ? '#ef4444' : 'var(--text-muted)' }} title={t.error ?? undefined}>
                          {t.error_code === 'dispatching' ? 'processando' : t.status === 'sent' ? 'encaminhado'
                            : t.status === 'replied' ? 'respondeu'
                            : t.status === 'failed' ? 'falhou'
                            : t.status === 'skipped' ? 'pulado'
                            : t.ai_blocked ? 'em atendimento'
                            : t.status === 'pending' ? '' : t.status}
                        </span>
                        {canSendNow && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" title="Enviar respeitando limites e intervalo"
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
            {!detailsOnly && <Button
              disabled={previewLoading || willSend.length === 0 || action.isPending}
              onClick={() => {
                if (!confirmId) return;
                action.mutate({ id: confirmId, op: 'start' }, {
                  onSuccess: () => { toast.success('Follow-up iniciado'); setConfirmId(null); },
                });
              }}
            >
              {action.isPending ? 'Iniciando...' : `Confirmar e disparar (${willSend.length})`}
            </Button>}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!cancelId} onOpenChange={(o) => { if (!o) setCancelId(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cancelar follow-up?</DialogTitle></DialogHeader>
          <p className="text-sm text-ink-2">
            Os próximos envios da campanha serão interrompidos. Mensagens já encaminhadas à fila de envio podem ser entregues. O histórico do que já foi enviado permanece.
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
