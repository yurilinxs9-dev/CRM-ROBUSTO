'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Check, Clock, Eye, FileText, Search, ShieldCheck, Sparkles, Users, X } from 'lucide-react';
import { api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ModelSelect, useAvailableAiModels } from '@/components/ai/model-select';

export interface CampaignConfig {
  id: string; name: string; mode: 'template' | 'ai'; stage_id: string | null;
  template?: string | null; ai_instruction?: string | null; model_config_id?: string | null;
  throttle_seconds: number; daily_limit: number; respect_ai_block?: boolean;
  segment?: { pipeline_id?: string; responsavel_id?: string; temperatura?: string; tags?: string[];
    inactive_days?: number; exclude_closed?: boolean; lead_ids?: string[]; scheduled_at?: string;
    window_start?: number; window_end?: number; window_days?: number[] } | null;
}
interface Pipeline { id: string; nome: string; stages: { id: string; nome: string }[] }
interface Lead { id: string; nome: string; telefone?: string; ai_blocked?: boolean; responsavel?: { nome: string } | null }
const DAYS = ['Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb', 'Dom'];
const STEPS = [{ label: 'Público', icon: Users }, { label: 'Mensagem', icon: FileText }, { label: 'Programação', icon: Clock }, { label: 'Revisão', icon: Check }];
const fieldClass = 'w-full rounded-lg border border-line-2 bg-surface-2 px-3 py-2.5 text-sm text-ink-1 outline-none focus:ring-2 focus:ring-brand';
function errorMessage(e: unknown) { const m = (e as { response?: { data?: { message?: string } } }).response?.data?.message; return typeof m === 'string' ? m : 'Não foi possível salvar. Verifique os campos e tente novamente.'; }
function brtInput(iso?: string) { return iso ? new Date(new Date(iso).getTime() - 10800000).toISOString().slice(0,16) : ''; }

export function CampaignEditor({ open, onClose, initial, pipelines, window: companyWindow }: {
  open: boolean; onClose: () => void; initial?: CampaignConfig | null; pipelines: Pipeline[];
  window: { start: number; end: number; days: number[] };
}) {
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [manual, setManual] = useState(false);
  const [ids, setIds] = useState<string[]>([]);
  const [selectedNames, setSelectedNames] = useState<Record<string,string>>({});
  const [pipeline, setPipeline] = useState('');
  const [stage, setStage] = useState('');
  const [owner, setOwner] = useState('');
  const [temperature, setTemperature] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [inactive, setInactive] = useState('0');
  const [excludeClosed, setExcludeClosed] = useState(true);
  const [mode, setMode] = useState<'template'|'ai'>('template');
  const [content, setContent] = useState('');
  const [instruction, setInstruction] = useState('');
  const [model, setModel] = useState<string|null>(null);
  const [interval, setIntervalValue] = useState('15');
  const [limit, setLimit] = useState('30');
  const [respect, setRespect] = useState(true);
  const [scheduled, setScheduled] = useState('');
  const [start, setStart] = useState(9);
  const [end, setEnd] = useState(18);
  const [days, setDays] = useState<number[]>([1,2,3,4,5]);
  const [search, setSearch] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const timer = setTimeout(() => setDebounced(search.trim()), 300); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    if (!open) return;
    const s = initial?.segment;
    setStep(0); setName(initial?.name ?? ''); setManual(!!s?.lead_ids?.length); setIds(s?.lead_ids ?? []); setSelectedNames({});
    setPipeline(s?.pipeline_id ?? ''); setStage(initial?.stage_id ?? ''); setOwner(s?.responsavel_id ?? '');
    setTemperature(s?.temperatura ?? ''); setTags(s?.tags ?? []); setInactive(String(s?.inactive_days ?? 0)); setExcludeClosed(s?.exclude_closed ?? true);
    setMode(initial?.mode ?? 'template'); setContent(initial?.template ?? ''); setInstruction(initial?.ai_instruction ?? ''); setModel(initial?.model_config_id ?? null);
    setIntervalValue(String((initial?.throttle_seconds ?? 900)/60)); setLimit(String(initial?.daily_limit ?? 30)); setRespect(initial?.respect_ai_block ?? true);
    setScheduled(brtInput(s?.scheduled_at)); setStart(s?.window_start ?? companyWindow.start); setEnd(s?.window_end ?? companyWindow.end); setDays(s?.window_days ?? companyWindow.days); setSearch('');
  // Reinitialize only when opening another campaign, never during form edits.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initial?.id]);
  const { data: users = [] } = useQuery<{ id: string; nome: string }[]>({ queryKey: ['followup-users'], queryFn: async () => (await api.get('/api/users/list')).data, enabled: open });
  const { data: availableTags = [] } = useQuery<{ id: string; nome: string }[]>({ queryKey: ['followup-tags'], queryFn: async () => (await api.get('/api/tags')).data, enabled: open });
  const { data: models = [] } = useAvailableAiModels();
  const audiencePayload = {
    pipeline_id: pipeline || null, stage_id: stage || null, responsavel_id: owner || null,
    temperatura: temperature || null, tags, inactive_days: Number(inactive), exclude_closed: excludeClosed,
    lead_ids: manual ? ids : null,
  };
  const audienceValid = (!manual || ids.length > 0) && Number.isInteger(Number(inactive)) && Number(inactive) >= 0 && Number(inactive) <= 365;
  const { data: audience, isFetching: audienceLoading, isError: audienceError } = useQuery<{ total: number; leads: Lead[] }>({
    queryKey: ['followup-audience', audiencePayload], queryFn: async () => (await api.post('/api/broadcasts/audience', audiencePayload)).data,
    enabled: open && audienceValid, staleTime: 10000,
  });
  const { data: results = [] } = useQuery<Lead[]>({ queryKey: ['followup-search', debounced], queryFn: async () => { const d = (await api.get('/api/leads', { params: { search: debounced, limit: 10 } })).data; return Array.isArray(d) ? d : d.data ?? []; }, enabled: open && manual && debounced.length >= 2 });
  const messagePayload = { ...audiencePayload, mode, template: mode === 'template' ? content.trim() : null, ai_instruction: mode === 'ai' ? instruction.trim() : null, model_config_id: mode === 'ai' ? model : null };
  const preview = useMutation({ mutationFn: async () => (await api.post<{ content: string; lead_nome: string }>('/api/broadcasts/preview', messagePayload)).data, onError: e => toast.error(errorMessage(e)) });
  const previewReset = preview.reset;
  const messageKey = JSON.stringify(messagePayload);
  useEffect(() => { previewReset(); }, [messageKey, previewReset]);
  const messageValid = mode === 'template' ? content.trim().length > 0 : instruction.trim().length > 0 && models.length > 0;
  const scheduleValid = Number.isFinite(Number(interval)) && Number(interval) >= .5 && Number(interval) <= 1440 && Number.isInteger(Number(limit)) && Number(limit) >= 1 && Number(limit) <= 200 && start < end && days.length > 0 && days.some(d => companyWindow.days.includes(d)) && Math.max(start, companyWindow.start) < Math.min(end, companyWindow.end) && (!scheduled || Number.isFinite(new Date(scheduled + ':00-03:00').getTime()));
  const save = useMutation({ mutationFn: async () => {
    const payload = { ...messagePayload, name: name.trim(), throttle_seconds: Math.round(Number(interval)*60), daily_limit: Number(limit), respect_ai_block: respect, scheduled_at: scheduled ? new Date(scheduled + ':00-03:00').toISOString() : null, window_start: start, window_end: end, window_days: days };
    return initial ? api.patch(`/api/broadcasts/${initial.id}`, payload) : api.post('/api/broadcasts', payload);
  }, onSuccess: () => { qc.invalidateQueries({ queryKey: ['broadcasts'] }); toast.success('Rascunho salvo. Revise os destinatários antes de iniciar.'); onClose(); }, onError: e => toast.error(errorMessage(e)) });
  const eligible = audienceValid && !!audience?.total && !audienceLoading && !audienceError;
  const stepsValid = [!!name.trim() && eligible, messageValid, scheduleValid, true];
  const valid = !!name.trim() && eligible && messageValid && scheduleValid;
  return <Dialog open={open} onOpenChange={v => { if (!v && !save.isPending) onClose(); }}>
    <DialogContent className="sm:max-w-4xl max-h-[94vh] overflow-y-auto p-0 gap-0">
      <div className="border-b border-line-2 p-5 sm:p-6 bg-surface-2"><DialogHeader><p className="text-[10px] font-semibold uppercase tracking-[.2em] text-brand mb-1">CENTRAL DE FOLLOW-UP</p><DialogTitle className="text-xl">{initial ? 'Editar campanha' : 'Uma nova conversa começa aqui'}</DialogTitle></DialogHeader>
        <div className="mt-5 grid grid-cols-4 gap-2">{STEPS.map(({ label, icon: Icon }, i) => <button type="button" key={label} disabled={i > step && !stepsValid.slice(0,i).every(Boolean)} onClick={() => setStep(i)} className={`flex items-center justify-center gap-2 rounded-lg p-2.5 text-xs border transition-colors ${step === i ? 'border-brand bg-brand-subtle text-brand' : 'border-line-2 text-ink-3 disabled:opacity-40'}`}><Icon className="h-4 w-4"/><span className="hidden sm:inline">{label}</span><span className="sm:hidden">{i+1}</span></button>)}</div>
      </div>
      <div className="grid md:grid-cols-[1fr_240px]">
        <div className="p-5 sm:p-6 space-y-5 min-w-0">
          {step === 0 && <>
            <div><Label htmlFor="campaign-name">Nome da campanha</Label><Input id="campaign-name" value={name} maxLength={120} onChange={e => setName(e.target.value)} placeholder="Ex.: Retomar orçamentos de setembro"/></div>
            <div className="grid grid-cols-2 gap-2">{[false,true].map(v => <button key={String(v)} type="button" onClick={() => setManual(v)} className={`p-3 rounded-xl border text-left text-sm ${manual === v ? 'border-brand bg-brand-subtle text-brand' : 'border-line-2'}`}>{v ? 'Escolher contatos' : 'Filtrar público'}<span className="block text-xs mt-1 text-ink-3">{v ? 'Uma seleção feita por você' : 'Combine critérios do CRM'}</span></button>)}</div>
            {manual && <div className="space-y-2"><Input aria-label="Buscar destinatários" value={search} onChange={e => setSearch(e.target.value)} placeholder="Busque por nome ou telefone"/>{results.filter(l => !ids.includes(l.id)).map(l => <button type="button" key={l.id} onClick={() => { setIds([...ids,l.id]); setSelectedNames({...selectedNames,[l.id]:l.nome}); setSearch(''); }} className="block w-full p-2 text-left text-sm rounded border border-line-2">{l.nome} <span className="text-ink-3">{l.telefone}</span></button>)}<div className="flex flex-wrap gap-1">{ids.map((id,i) => <button key={id} type="button" onClick={() => setIds(ids.filter(v => v !== id))} className="inline-flex items-center gap-1 rounded-full bg-surface-3 px-2 py-1 text-xs">{selectedNames[id] ?? audience?.leads.find(l=>l.id===id)?.nome ?? `Contato ${i+1}`}<X className="h-3 w-3"/></button>)}</div><p className="text-xs text-ink-3">Os filtros abaixo também se aplicam aos contatos escolhidos.</p></div>}
            <div className="grid grid-cols-2 gap-4">
              <div><Label htmlFor="campaign-pipeline">Funil</Label><select id="campaign-pipeline" className={fieldClass} value={pipeline} onChange={e=>{setPipeline(e.target.value);setStage('');}}><option value="">Todos os funis</option>{pipelines.map(p=><option key={p.id} value={p.id}>{p.nome}</option>)}</select></div>
              <div><Label htmlFor="campaign-stage">Etapa</Label><select id="campaign-stage" className={fieldClass} value={stage} onChange={e=>setStage(e.target.value)}><option value="">Todas as etapas</option>{pipelines.filter(p=>!pipeline||p.id===pipeline).flatMap(p=>p.stages.map(s=><option key={s.id} value={s.id}>{p.nome} · {s.nome}</option>))}</select></div>
              <div><Label htmlFor="campaign-owner">Responsável</Label><select id="campaign-owner" className={fieldClass} value={owner} onChange={e=>setOwner(e.target.value)}><option value="">Toda a equipe</option>{users.map(u=><option key={u.id} value={u.id}>{u.nome}</option>)}</select></div>
              <div><Label htmlFor="campaign-temperature">Temperatura</Label><select id="campaign-temperature" className={fieldClass} value={temperature} onChange={e=>setTemperature(e.target.value)}><option value="">Todas</option>{[['FRIO','Frio'],['MORNO','Morno'],['QUENTE','Quente'],['MUITO_QUENTE','Muito quente']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div>
            </div>
            <div><Label htmlFor="campaign-inactive">Sem interação há pelo menos (dias)</Label><Input id="campaign-inactive" type="number" min={0} max={365} value={inactive} onChange={e=>setInactive(e.target.value)}/><p className="text-xs text-ink-3 mt-1">Use 0 para não filtrar por tempo.</p></div>
            <div><Label>Tags — qualquer uma das selecionadas</Label><div className="flex flex-wrap gap-2 mt-2">{availableTags.length ? availableTags.map(t=><button type="button" key={t.id} onClick={()=>setTags(tags.includes(t.nome)?tags.filter(v=>v!==t.nome):[...tags,t.nome])} className={`rounded-full border px-3 py-1 text-xs ${tags.includes(t.nome)?'border-brand bg-brand-subtle text-brand':'border-line-2 text-ink-2'}`}>{t.nome}</button>):<p className="text-xs text-ink-3">Sem tags cadastradas.</p>}</div></div>
            <label className="flex justify-between items-center gap-4 text-sm rounded-xl border border-line-2 p-3">Excluir negócios ganhos e perdidos<Switch checked={excludeClosed} onCheckedChange={setExcludeClosed}/></label>
          </>}
          {step === 1 && <>
            <div className="grid grid-cols-2 gap-3">{(['template','ai'] as const).map(v=><button type="button" key={v} onClick={()=>setMode(v)} className={`rounded-xl border p-4 text-left ${mode===v?'border-brand bg-brand-subtle':'border-line-2'}`}>{v==='ai'?<Sparkles className="h-5 w-5 text-brand"/>:<FileText className="h-5 w-5 text-brand"/>}<p className="text-sm font-semibold mt-2">{v==='ai'?'Personalizar com IA':'Texto com variáveis'}</p><p className="text-xs text-ink-3 mt-1">{v==='ai'?'Defina a intenção e o tom':'Você controla cada palavra'}</p></button>)}</div>
            <div><Label htmlFor="campaign-content">{mode==='ai'?'Instrução para a IA':'Mensagem'}</Label><textarea id="campaign-content" className={`${fieldClass} min-h-40`} maxLength={2000} value={mode==='ai'?instruction:content} onChange={e=>mode==='ai'?setInstruction(e.target.value):setContent(e.target.value)} placeholder={mode==='ai'?'Retome o orçamento de forma breve e cordial. Não invente descontos ou prazos.':'{saudacao}, {primeiro_nome}! Podemos dar continuidade ao seu orçamento?'}/><p className="text-right text-xs text-ink-3">{(mode==='ai'?instruction:content).length}/2000</p></div>
            {mode==='template'?<div className="flex gap-2 flex-wrap">{['{primeiro_nome}','{nome}','{saudacao}','{empresa}','{atendente}','{telefone}'].map(v=><button type="button" key={v} onClick={()=>setContent(c=>(c+' '+v).trim().slice(0,2000))} className="text-xs rounded-full border border-line-2 px-2 py-1 text-brand">{v}</button>)}</div>:<div><Label>Modelo de IA</Label><ModelSelect value={model} onChange={setModel} placeholder="Modelo padrão"/>{!models.length&&<p className="text-warning text-xs mt-2">Configure um modelo de IA ou escolha texto com variáveis.</p>}</div>}
            <Button variant="outline" disabled={!messageValid||!eligible||preview.isPending} onClick={()=>preview.mutate()}><Eye className="h-4 w-4 mr-2"/>{preview.isPending?'Preparando prévia…':'Prévia com um contato real'}</Button>
            {preview.data&&<div className="rounded-xl border border-brand-border bg-brand-subtle p-4"><p className="text-xs text-ink-3 mb-2">Exemplo para {preview.data.lead_nome} · nenhum envio realizado</p><p className="text-sm whitespace-pre-wrap">{preview.data.content}</p></div>}
          </>}
          {step === 2 && <>
            <div><Label htmlFor="campaign-schedule">Data de início (opcional, horário de Brasília)</Label><Input id="campaign-schedule" type="datetime-local" value={scheduled} onChange={e=>setScheduled(e.target.value)}/><p className="text-xs text-ink-3 mt-1">Sem data, fica pronto para iniciar quando você confirmar.</p></div>
            <div className="grid grid-cols-2 gap-4"><div><Label htmlFor="campaign-interval">Intervalo (minutos)</Label><Input id="campaign-interval" type="number" min={.5} max={1440} step={.5} value={interval} onChange={e=>setIntervalValue(e.target.value)}/></div><div><Label htmlFor="campaign-limit">Limite diário da campanha</Label><Input id="campaign-limit" type="number" min={1} max={200} value={limit} onChange={e=>setLimit(e.target.value)}/></div></div>
            <div className="flex gap-2 flex-wrap">{[{label:'30/dia · 15 min',l:30,i:15},{label:'20/dia · 30 min',l:20,i:30},{label:'10/dia · 60 min',l:10,i:60}].map(p=><button type="button" key={p.l} onClick={()=>{setLimit(String(p.l));setIntervalValue(String(p.i));}} className="text-xs border border-line-2 rounded-full px-3 py-2">{p.label}</button>)}</div>
            <div><Label>Dias de envio</Label><div className="flex gap-2 flex-wrap mt-2">{DAYS.map((d,i)=><button key={d} type="button" aria-pressed={days.includes(i+1)} onClick={()=>setDays(days.includes(i+1)?days.filter(v=>v!==i+1):[...days,i+1])} className={`rounded-lg p-2 text-xs border ${days.includes(i+1)?'border-brand text-brand bg-brand-subtle':'border-line-2'}`}>{d}</button>)}</div></div>
            <div className="grid grid-cols-2 gap-4"><div><Label htmlFor="campaign-start">A partir das</Label><select id="campaign-start" className={fieldClass} value={start} onChange={e=>setStart(Number(e.target.value))}>{Array.from({length:24},(_,i)=><option key={i} value={i}>{String(i).padStart(2,'0')}:00</option>)}</select></div><div><Label htmlFor="campaign-end">Até</Label><select id="campaign-end" className={fieldClass} value={end} onChange={e=>setEnd(Number(e.target.value))}>{Array.from({length:24},(_,i)=><option key={i+1} value={i+1}>{String(i+1).padStart(2,'0')}:00</option>)}</select></div></div>
            <p className="text-xs text-ink-3">Os envios respeitam também o horário da empresa: {companyWindow.start}h–{companyWindow.end}h, {companyWindow.days.map(d=>DAYS[d-1]).join(', ')}. Fora dele, a fila aguarda.</p>
            <label className="flex justify-between items-center gap-4 text-sm border border-line-2 rounded-xl p-3">Pular contatos em atendimento humano<Switch checked={respect} onCheckedChange={setRespect}/></label>
            {!scheduleValid&&<p role="alert" className="text-sm text-danger">Confira os limites e escolha dias e horários compatíveis com os da empresa.</p>}
          </>}
          {step === 3 && <>
            <div><p className="text-xs text-brand uppercase tracking-widest">Tudo pronto para revisar</p><h3 className="text-2xl font-semibold mt-2">{name}</h3><p className="text-sm text-ink-3 mt-2">O público é salvo com o rascunho. Antes de enviar, o sistema confere novamente as condições de cada contato.</p></div>
            <div className="rounded-xl bg-surface-2 border border-line-2 p-4 text-sm space-y-3"><p><strong>{audience?.total??0} contatos</strong> no público selecionado</p><p>{mode==='ai'?'Mensagem personalizada por IA':'Texto com variáveis'} · {limit} tentativas/dia · intervalo de {interval} min</p><p>{days.map(d=>DAYS[d-1]).join(', ')} · {start}h–{end}h (Brasília)</p><p>{scheduled?`A partir de ${scheduled.replace('T',' às ')}`:'Início após confirmação manual'}</p></div>
            <div className="rounded-xl border border-line-2 p-4"><p className="text-xs text-ink-3 mb-2">{mode==='ai'?'Instrução da IA':'Mensagem'}</p><p className="whitespace-pre-wrap text-sm">{mode==='ai'?instruction:content}</p></div>
            <p className="text-sm text-ink-3">Salvar não envia mensagens. Você poderá editar o rascunho ou revisar os destinatários e iniciar depois.</p>
          </>}
        </div>
        <aside className="border-t md:border-t-0 md:border-l border-line-2 bg-surface-2 p-5 space-y-5">
          <div><p className="text-xs uppercase tracking-widest text-ink-3">Público selecionado</p><p className="text-4xl font-semibold mt-2">{audienceLoading?'…':audienceError?'—':audienceValid?audience?.total??0:0}</p><p className="text-xs text-ink-3 mt-1">contatos antes das proteções de envio</p></div>
          {audienceError&&<p role="alert" className="text-xs text-danger">Não foi possível consultar o público. Tente novamente.</p>}
          <div className="space-y-2 max-h-48 overflow-y-auto">{audience?.leads.slice(0,8).map(l=><div key={l.id} className="text-xs border-b border-line-2 pb-2"><p className="font-medium truncate">{l.nome}</p><p className="text-ink-3 truncate">{l.responsavel?.nome??'Sem responsável'}{l.ai_blocked&&respect?' · em atendimento':''}</p></div>)}</div>
          <div className="rounded-xl border border-brand-border bg-brand-subtle p-3"><ShieldCheck className="h-5 w-5 text-brand mb-2"/><p className="text-xs font-semibold">Proteções em todos os envios</p><p className="text-xs text-ink-3 mt-2 leading-relaxed">Limite diário, intervalo e horário valem também para envio manual. Respostas retiram o contato da fila.</p><p className="text-xs text-ink-3 mt-2">Teto total: 200 tentativas/dia por empresa. O intervalo é compartilhado entre as campanhas, com mínimo de 30 segundos.</p></div>
        </aside>
      </div>
      <div className="flex justify-between border-t border-line-2 p-4 bg-surface-2"><Button variant="ghost" onClick={()=>step?setStep(step-1):onClose()} disabled={save.isPending}><ArrowLeft className="h-4 w-4 mr-2"/>{step?'Voltar':'Cancelar'}</Button>{step<3?<Button disabled={!stepsValid[step]} onClick={()=>setStep(step+1)}>Continuar<ArrowRight className="h-4 w-4 ml-2"/></Button>:<Button disabled={!valid||save.isPending} onClick={()=>save.mutate()}>{save.isPending?'Salvando…':'Salvar rascunho'}</Button>}</div>
    </DialogContent>
  </Dialog>;
}
