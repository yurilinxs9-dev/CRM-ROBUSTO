'use client';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { type TeamActivity, type TeamDashboard, type TeamKind, type TeamMember, type TeamSubject, teamError, teamLabels } from '@/lib/partner-team';
import { Button } from '@/components/ui/button';
import { Field, fieldClass } from './partner-forms';

function TeamForm({ children, save, label, disabled = false }: { children: ReactNode; save: () => Promise<void>; label: string; disabled?: boolean }) {
  const lock = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) { e.preventDefault(); if (lock.current || disabled) return; lock.current = true; setBusy(true); setError(''); try { await save(); } catch (e) { setError(teamError(e)); } finally { lock.current = false; setBusy(false); } }
  return <form onSubmit={submit} className="space-y-4"><fieldset className="space-y-4" disabled={busy || disabled}>{children}</fieldset>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button className="w-full" disabled={busy || disabled}>{busy ? 'Salvando…' : label}</Button></form>;
}
export function TeamActivityForm({ row, initialKind, members, userId, manager, today, tenant, saved }: { row?: TeamActivity; initialKind: TeamKind; members: TeamMember[]; userId: string; manager: boolean; today: string; tenant: string; saved: () => Promise<void> }) {
  const [kind, setKind] = useState<TeamKind>(row?.kind ?? initialKind);
  const [consultant, setConsultant] = useState(row?.consultant_id ?? (manager ? '' : userId));
  const [date, setDate] = useState(row?.occurred_on ?? today);
  const [time, setTime] = useState(row?.occurred_time ?? new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date()));
  const [note, setNote] = useState(row?.note ?? ''); const [search, setSearch] = useState(''); const [debounced, setDebounced] = useState('');
  const [subject, setSubject] = useState<TeamSubject | null>(null); const [company, setCompany] = useState(''); const [confirmed, setConfirmed] = useState(false);
  const requestId = useRef<string | null>(null);
  useEffect(() => { const timer = setTimeout(() => setDebounced(search), 250); return () => clearTimeout(timer); }, [search]);
  const subjects = useQuery({ queryKey: ['partner-team-subjects', tenant, debounced], queryFn: async () => (await api.get<TeamSubject[]>('/api/partners/team/subjects', { params: { search: debounced } })).data, enabled: !row });
  const candidates = members.filter(m => (m.active || m.id === row?.consultant_id) && (manager || m.id === userId));
  async function save() {
    const fields = { consultant_id: consultant, occurred_on: date, occurred_time: kind === 'registration' ? '00:00' : time, note };
    if (row) await api.patch(`/api/partners/team/activities/${row.id}`, { ...fields, expectedVersion: row.version });
    else {
      if (!subject) throw new Error('Selecione uma empresa ou contato.');
      if (kind === 'registration' && !confirmed) throw new Error('Confirme a efetivação do cadastro.');
      requestId.current ??= crypto.randomUUID();
      await api.post('/api/partners/team/activities', { ...fields, kind, request_id: requestId.current, subject_type: subject.type, subject_id: subject.id, ...(kind === 'registration' && subject.type === 'lead' ? { company_name: company } : {}) });
    }
    await saved();
  }
  return <TeamForm label={row ? 'Salvar correção' : kind === 'registration' ? 'Confirmar cadastro efetivado' : 'Registrar atividade realizada'} save={save}>
    {row ? <div className="rounded-lg bg-muted p-3 text-sm"><strong>{row.company_name}</strong><p>{teamLabels[row.kind]}</p><p className="mt-1 text-muted-foreground">A correção substitui este registro e recalcula os resultados.</p></div> : <>
      <Field label="Tipo de atividade"><select className={fieldClass} value={kind} onChange={e => { setKind(e.target.value as TeamKind); setConfirmed(false); }}>{Object.entries(teamLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
      <Field label="Buscar empresa ou contato do Kanban"><input className={fieldClass} maxLength={200} value={search} onChange={e => { setSearch(e.target.value); setSubject(null); setCompany(''); }} placeholder="Nome da empresa, pessoa ou telefone" /></Field>
      <Field label="Empresa / contato"><select required className={fieldClass} value={subject ? `${subject.type}:${subject.id}` : ''} onChange={e => { const selected = subjects.data?.find(s => `${s.type}:${s.id}` === e.target.value) ?? null; setSubject(selected); setCompany(selected?.company ?? ''); }}><option value="">{subjects.isFetching ? 'Buscando…' : 'Selecione'}</option>{subjects.data?.map(s => <option key={`${s.type}:${s.id}`} value={`${s.type}:${s.id}`}>{s.name}{s.contact && s.contact !== s.name ? ` · ${s.contact}` : ''}{s.phone ? ` · ${s.phone}` : ''} — {s.type === 'partner' ? 'Parceiro' : 'Kanban'}</option>)}</select></Field>
      {subjects.isError && <p role="alert" className="text-sm text-destructive">Falha ao buscar contatos. <button type="button" className="underline" onClick={() => void subjects.refetch()}>Tentar novamente</button></p>}
      {!subjects.isFetching && subjects.data?.length === 0 && <p className="text-sm text-muted-foreground">Nenhum resultado. Cadastre o contato no Kanban ou a empresa em Parceiros primeiro.</p>}
      {kind === 'registration' && subject?.type === 'lead' && <Field label="Nome da empresa que será cadastrada"><input required maxLength={200} className={fieldClass} value={company} onChange={e => setCompany(e.target.value)} /><span className="text-xs font-normal text-muted-foreground">A empresa será adicionada à lista de Parceiros, vinculada a este contato.</span></Field>}
    </>}
    <Field label="Consultora responsável"><select required className={fieldClass} disabled={!manager} value={consultant} onChange={e => setConsultant(e.target.value)}><option value="">Selecione a consultora</option>{candidates.map(m => <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (inativa)'}</option>)}</select></Field>
    <div className="grid gap-3 sm:grid-cols-2"><Field label={kind === 'registration' ? 'Data da efetivação' : 'Data em que foi realizada'}><input required className={fieldClass} type="date" min="2000-01-01" max={today} value={date} onChange={e => setDate(e.target.value)} /></Field>{kind !== 'registration' && <Field label="Horário (Brasília)"><input required type="time" className={fieldClass} value={time} onChange={e => setTime(e.target.value)} /></Field>}</div>
    <Field label="Observação / motivo da correção"><textarea className={fieldClass} maxLength={2000} value={note} onChange={e => setNote(e.target.value)} /></Field>
    {!row && kind === 'registration' ? <label className="flex gap-2 text-sm"><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} /><span>Confirmo que este cadastro foi efetivado na data informada e pertence à consultora selecionada. Cada parceiro conta uma única vez.</span></label> : <p className="text-xs text-muted-foreground">Registre apenas atividades realizadas. Agendamentos não entram nos resultados. Mesmo tipo, empresa, data e horário contam uma única vez.</p>}
  </TeamForm>;
}
export function TeamGoalForm({ month, members, tenant, initialConsultant, saved }: { month: string; members: TeamMember[]; tenant: string; initialConsultant?: string; saved: () => Promise<void> }) {
  const [consultant, setConsultant] = useState(initialConsultant ?? ''); const [target, setTarget] = useState('');
  const query = useQuery({ queryKey: ['partner-team-goal', tenant, month, consultant], enabled: !!consultant, queryFn: async () => (await api.get<TeamDashboard>('/api/partners/team', { params: { month, consultant_id: consultant } })).data });
  const current = query.data?.performance.find(r => r.id === consultant);
  useEffect(() => { setTarget(current?.target === null || current?.target === undefined ? '' : String(current.target)); }, [consultant, current?.target, current?.goal_version]);
  return <TeamForm label="Salvar meta de cadastros" disabled={!!consultant && (query.isLoading || query.isError)} save={async () => { if (!consultant || !query.data) throw new Error('Selecione uma consultora e aguarde os dados.'); await api.put(`/api/partners/team/goals/${consultant}/${month}`, { target: Number(target), expectedVersion: current?.goal_version ?? 0 }); await saved(); }}>
    <p className="text-sm text-muted-foreground">Meta individual de cadastros efetivados em {month.split('-').reverse().join('/')}.</p>
    <Field label="Consultora"><select required className={fieldClass} value={consultant} onChange={e => { setConsultant(e.target.value); setTarget(''); }}><option value="">Selecione</option>{members.filter(m => m.active || m.id === initialConsultant).map(m => <option key={m.id} value={m.id}>{m.name}{m.active ? '' : ' (inativa)'}</option>)}</select></Field>
    <Field label="Quantidade de novos cadastros efetivados"><input required className={fieldClass} type="number" min={0} max={100000} step={1} value={target} onChange={e => setTarget(e.target.value)} /></Field>
    {query.isError && <p role="alert" className="text-sm text-destructive">Não foi possível consultar a meta atual. Feche e tente novamente.</p>}
  </TeamForm>;
}
export function TeamCancellationForm({ row, saved }: { row: TeamActivity; saved: () => Promise<void> }) {
  const [reason, setReason] = useState('');
  return <TeamForm label={row.cancelled ? 'Restaurar atividade' : 'Cancelar atividade'} save={async () => { await api.put(`/api/partners/team/activities/${row.id}/cancellation`, { expectedVersion: row.version, cancelled: !row.cancelled, reason }); await saved(); }}>
    <p className="text-sm"><strong>{teamLabels[row.kind]}</strong> · {row.company_name}</p><p className="text-sm text-muted-foreground">{row.cancelled ? 'O registro voltará a contar nos resultados da consultora e do mês originais.' : 'O registro deixará de contar nos resultados. A empresa e o histórico serão preservados.'}</p>
    <Field label="Motivo"><textarea required minLength={3} maxLength={1000} className={fieldClass} value={reason} onChange={e => setReason(e.target.value)} /></Field>
  </TeamForm>;
}
