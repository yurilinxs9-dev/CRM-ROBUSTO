'use client';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { isAxiosError } from 'axios';
import { api } from '@/lib/api';
import { amountInput, brl, parsePartnerAmount, type Partner, type PartnerCandidate, type PartnerDashboard, type Production } from '@/lib/partners';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';

export const fieldClass = 'w-full rounded-md border border-input bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring disabled:opacity-50';
export function Field({ label, children }: { label: string; children: ReactNode }) { return <label className="block space-y-1.5 text-sm font-medium"><span>{label}</span>{children}</label>; }
function SaveForm({ children, save, label = 'Salvar' }: { children: ReactNode; save: () => Promise<void>; label?: string }) {
  const lock = useRef(false); const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [conflict, setConflict] = useState(false);
  async function submit(e: FormEvent) { e.preventDefault(); if (lock.current || conflict) return; lock.current = true; setBusy(true); setError(''); try { await save(); } catch (err) { if (isAxiosError(err) && err.response?.status === 409) { setConflict(true); setError('Este registro já foi alterado. Feche esta janela, atualize a lista e confira o total antes de salvar novamente.'); } else { const message = isAxiosError(err) ? err.response?.data?.message : err instanceof Error ? err.message : ''; setError(typeof message === 'string' ? message : 'Não foi possível salvar. Confira os dados e tente novamente.'); } } finally { setBusy(false); lock.current = false; } }
  return <form onSubmit={submit} className="space-y-4"><fieldset disabled={busy || conflict} className="space-y-4">{children}</fieldset>{error && <p role="alert" className="text-sm text-destructive">{error}</p>}<Button type="submit" disabled={busy || conflict} className="w-full">{busy ? 'Salvando…' : label}</Button></form>;
}
export function PartnerModal({ title, description, children, close }: { title: string; description: string; children: ReactNode; close: () => void }) { return <Dialog open onOpenChange={open => { if (!open) close(); }}><DialogContent className="max-h-[90dvh] overflow-y-auto"><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>{children}</DialogContent></Dialog>; }

export function PartnerForm({ partner, data, tenant, saved }: { partner?: Partner; data: PartnerDashboard; tenant: string; saved: () => Promise<void> }) {
  const [name, setName] = useState(partner?.name ?? ''); const [contact, setContact] = useState(partner?.contact ?? ''); const [phone, setPhone] = useState(partner?.phone ?? ''); const [notes, setNotes] = useState(partner?.notes ?? ''); const [joined, setJoined] = useState(partner?.joined_on ?? data.today); const [owner, setOwner] = useState(partner?.owner_id ?? ''); const [active, setActive] = useState(partner?.active ?? true); const [lead, setLead] = useState(''); const [search, setSearch] = useState('');
  const candidates = useQuery({ queryKey: ['partner-candidates', tenant, search], queryFn: async () => (await api.get<PartnerCandidate[]>('/api/partners/candidates', { params: { search } })).data, enabled: !partner });
  async function save() { const body = { name: name.trim(), contact: contact.trim() || null, phone: phone.trim() || null, notes: notes.trim() || null, joined_on: joined, owner_id: owner || null }; if (partner) await api.patch(`/api/partners/${partner.id}`, { ...body, active, expectedVersion: partner.version }); else await api.post('/api/partners', { ...body, ...(lead ? { lead_id: lead } : {}) }); await saved(); }
  return <SaveForm save={save} label={partner ? 'Salvar parceiro' : 'Cadastrar parceiro'}>
    {!partner && <div className="rounded-lg bg-muted/50 p-3 space-y-2"><Field label="Vincular a um lead em Cadastro (opcional)"><input className={fieldClass} placeholder="Buscar por nome ou telefone" value={search} onChange={e => setSearch(e.target.value)} /></Field><select aria-label="Lead cadastrado" className={fieldClass} value={lead} onChange={e => { const c = candidates.data?.find(item => item.id === e.target.value); setLead(e.target.value); if (c) { setName(c.company?.trim() || ''); setContact(c.name); setPhone(c.phone); } }}><option value="">Cadastro manual / parceiro antigo</option>{candidates.data?.map(c => <option key={c.id} value={c.id}>{c.company || c.name} — {c.phone}</option>)}</select>{candidates.isError && <p className="text-xs text-destructive">Não foi possível carregar os leads. O cadastro manual continua disponível.</p>}<p className="text-xs text-muted-foreground">Somente leads da etapa Cadastro. O histórico original é mantido.</p></div>}
    <Field label="Nome da empresa"><input required placeholder="Ex.: Empresa de Consórcios" maxLength={160} className={fieldClass} value={name} onChange={e => setName(e.target.value)} /></Field>
    <p className="text-xs text-muted-foreground">O nome da empresa aparece nas listas, nos lançamentos e no ranking. Informe o nome da pessoa no contato abaixo.</p><div className="grid gap-3 sm:grid-cols-2"><Field label="Pessoa de contato"><input maxLength={160} className={fieldClass} value={contact} onChange={e => setContact(e.target.value)} /></Field><Field label="Telefone"><input maxLength={30} type="tel" className={fieldClass} value={phone} onChange={e => setPhone(e.target.value)} /></Field></div>
    <div className="grid gap-3 sm:grid-cols-2"><Field label="Data de cadastro"><input required type="date" className={fieldClass} value={joined} max={data.today} onChange={e => setJoined(e.target.value)} /></Field><Field label="Responsável interno"><select className={fieldClass} value={owner} onChange={e => setOwner(e.target.value)}><option value="">Sem responsável</option>{data.members.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}</select></Field></div>
    <Field label="Observações"><textarea maxLength={2000} className={fieldClass} value={notes} onChange={e => setNotes(e.target.value)} /></Field>
    {partner && <label className="flex gap-2 text-sm"><input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} />Parceiro ativo — desativar mantém o histórico de vendas</label>}
  </SaveForm>;
}

export function ProductionForm({ partner, entry, date, today, saved }: { partner: Partner; entry?: Production; date: string; today: string; saved: () => Promise<void> }) {
  const [amount, setAmount] = useState(entry ? amountInput(entry.amount) : ''); const [note, setNote] = useState(entry?.note ?? '');
  return <SaveForm save={async () => { await api.put(`/api/partners/${partner.id}/production/${date}`, { amount: parsePartnerAmount(amount), note: note.trim() || null, expectedVersion: entry?.version ?? 0 }); await saved(); }} label={entry ? 'Substituir total do dia' : 'Registrar vendas do dia'}>
    <div className="rounded-lg bg-muted p-3 text-sm"><p className="font-semibold">{partner.name}</p><p>{date.split('-').reverse().join('/')}</p>{entry ? <p className="mt-2">Total atual: <strong>{brl(entry.amount)}</strong>. O novo valor substituirá esse total.</p> : <p className="mt-2">Informe a soma das vendas deste parceiro no dia. Não inclua valores de outros dias.</p>}</div>
    <Field label="Total vendido no dia (R$)"><input required inputMode="decimal" placeholder="Ex.: 250.000,00" className={fieldClass} value={amount} onChange={e => setAmount(e.target.value)} disabled={date > today} /></Field>
    <Field label="Observação / motivo da correção"><textarea maxLength={2000} className={fieldClass} value={note} onChange={e => setNote(e.target.value)} /></Field>
    <p className="text-xs text-muted-foreground">Digite 0,00 para registrar um dia sem vendas. Cada alteração fica no histórico.</p>
  </SaveForm>;
}

export function GoalForm({ data, saved }: { data: PartnerDashboard; saved: () => Promise<void> }) {
  const [amount, setAmount] = useState(data.goal ? amountInput(data.goal.amount) : '');
  return <SaveForm save={async () => { await api.put(`/api/partners/goals/${data.month}`, { amount: parsePartnerAmount(amount), expectedVersion: data.goal?.version ?? 0 }); await saved(); }} label="Salvar meta do mês"><Field label={`Meta de vendas — ${data.month.split('-').reverse().join('/')}`}><input required className={fieldClass} inputMode="decimal" value={amount} onChange={e => setAmount(e.target.value)} placeholder="Informe a meta em reais" /></Field><p className="text-sm text-muted-foreground">A meta considera a soma das vendas de todos os parceiros no mês selecionado.</p></SaveForm>;
}
