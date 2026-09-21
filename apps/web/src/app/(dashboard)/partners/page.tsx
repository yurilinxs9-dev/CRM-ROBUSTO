'use client';
import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, Target, Users, Pencil, History, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { useAuthStore } from '@/stores/auth.store';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { brl, canAccessPartners, saoPauloDate, type Partner, type PartnerDashboard, type Production, type PartnerAudit } from '@/lib/partners';
import { Button } from '@/components/ui/button';
import { TeamPerformance } from '@/components/partners/team-performance';
import { PartnerSummary } from '@/components/partners/partner-summary';
import { DeletePartnerForm, Field, fieldClass, GoalForm, PartnerForm, PartnerModal, ProductionForm } from '@/components/partners/partner-forms';

type Editor = { kind: 'delete'; partner: Partner } | { kind: 'partner'; partner?: Partner; snapshot: PartnerDashboard } | { kind: 'production'; partner: Partner; entry?: Production; date: string; snapshot: PartnerDashboard } | { kind: 'goal'; snapshot: PartnerDashboard };

export default function PartnersPage() {
  const user = useAuthStore(s => s.user);
  if (!canAccessPartners(user?.tenantId)) return <div className="p-8"><h1 className="text-xl font-semibold">Área indisponível</h1><p className="mt-2 text-muted-foreground">Este workspace não possui acesso à área de parceiros.</p></div>;
  return <PartnersWorkspace key={user!.tenantId} tenant={user!.tenantId} role={user!.role} userId={user!.id} />;
}

function PartnersWorkspace({ tenant, role, userId }: { tenant: string; role: string; userId: string }) {
  const qc = useQueryClient();
  const [month, setMonth] = useState(() => saoPauloDate().slice(0, 7));
  const [tab, setTab] = useState<'summary' | 'partners' | 'entries' | 'team' | 'audit'>('summary');
  const [editor, setEditor] = useState<Editor | null>(null);
  const manager = role === 'SUPER_ADMIN' || role === 'GERENTE';
  const canWrite = manager || role === 'OPERADOR';
  const query = useQuery({ queryKey: ['partners', tenant, month], queryFn: async () => (await api.get<PartnerDashboard>('/api/partners', { params: { month } })).data, refetchInterval: 30000 });
  const audit = useQuery({ queryKey: ['partner-audit', tenant], queryFn: async () => (await api.get<PartnerAudit[]>('/api/partners/audit')).data, enabled: manager && tab === 'audit' });
  useEffect(() => { const socket = getSocket(); const refresh = () => { void qc.invalidateQueries({ queryKey: ['partners', tenant] }); void qc.invalidateQueries({ queryKey: ['partner-audit', tenant] }); }; socket.on('partners:updated', refresh); return () => { socket.off('partners:updated', refresh); }; }, [qc, tenant]);
  async function saved() { setEditor(null); toast.success(editor?.kind === 'delete' ? 'Parceiro excluído.' : 'Registro salvo.'); await Promise.all([qc.invalidateQueries({ queryKey: ['partners', tenant] }), qc.invalidateQueries({ queryKey: ['partner-audit', tenant] }), qc.invalidateQueries({ queryKey: ['partner-candidates', tenant] })]); }
  const data = query.data;
  return <main className="mx-auto w-full max-w-[1600px] space-y-6 p-4 sm:p-6 lg:p-8">
    <header className="flex flex-wrap items-start justify-between gap-4"><div><div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-600"><Users className="h-4 w-4" />Rede de parceiros</div><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">Parceiros e produção</h1><p className="mt-2 text-sm text-muted-foreground">Acompanhe as vendas, os parceiros que mais produzem e o caminho até a meta.</p></div><div className="flex flex-wrap items-center gap-2"><input type="month" aria-label="Mês do relatório" className={`${fieldClass} w-auto`} min="2000-01" max="2100-12" value={month} onChange={e => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { setMonth(e.target.value); setEditor(null); } }} /><Button variant="outline" size="icon" title="Atualizar dados" aria-label="Atualizar dados" onClick={() => { void query.refetch(); if (tab === 'audit') void audit.refetch(); }} disabled={query.isFetching}><RefreshCw className={`h-4 w-4 ${query.isFetching ? 'animate-spin' : ''}`} /></Button></div></header>
    <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3"><nav aria-label="Visões dos parceiros" className="flex flex-wrap gap-1">{(['summary', 'partners', 'entries', 'team', ...(manager ? ['audit' as const] : [])] as const).map(t => <Button key={t} variant={tab === t ? 'secondary' : 'ghost'} onClick={() => setTab(t)} aria-pressed={tab === t}>{({ summary: 'Resumo', partners: 'Parceiros', entries: 'Lançamentos', team: 'Desempenho da equipe', audit: 'Histórico' } as const)[t]}</Button>)}</nav>{manager && data && tab !== 'team' && <div className="flex gap-2"><Button variant="outline" onClick={() => setEditor({ kind: 'goal', snapshot: data })}><Target className="mr-2 h-4 w-4" />{data.goal ? 'Editar meta' : 'Definir meta'}</Button><Button onClick={() => setEditor({ kind: 'partner', snapshot: data })}><Plus className="mr-2 h-4 w-4" />Novo parceiro</Button></div>}</div>
    {query.isLoading && <div className="py-20 text-center text-muted-foreground" role="status">Carregando a produção dos parceiros…</div>}
    {query.isError && <div role="alert" className="rounded-lg border border-destructive/30 p-5"><p>Não foi possível carregar os dados. Tente atualizar.</p><Button className="mt-3" variant="outline" onClick={() => { void query.refetch(); }}>Tentar novamente</Button></div>}
    {data && !query.isError && <>
      {tab === 'team' && <TeamPerformance key={month} month={month} tenant={tenant} userId={userId} role={role} />}
      {tab === 'summary' && <PartnerSummary data={data} />}
      {tab === 'partners' && <PartnerList data={data} manager={manager} remove={partner => setEditor({ kind: 'delete', partner })} edit={p => setEditor({ kind: 'partner', partner: p, snapshot: data })} />}
      {tab === 'entries' && <Entries key={month} data={data} canWrite={canWrite} manager={manager} edit={(partner, date, entry) => setEditor({ kind: 'production', partner, date, entry, snapshot: data })} />}
      {tab === 'audit' && manager && <AuditList rows={audit.data} loading={audit.isLoading} error={audit.isError} partners={data.partners} />}
    </>}
    {editor && <PartnerModal close={() => setEditor(null)} title={editor.kind === 'delete' ? 'Excluir parceiro' : editor.kind === 'partner' ? editor.partner ? 'Editar parceiro' : 'Cadastrar parceiro' : editor.kind === 'goal' ? 'Meta mensal' : editor.entry ? 'Corrigir vendas do dia' : 'Registrar vendas'} description={editor.kind === 'delete' ? 'Confira o cadastro antes de confirmar a exclusão.' : editor.kind === 'production' ? 'Um único total por parceiro e dia. O fechamento mensal é automático.' : editor.kind === 'goal' ? 'Defina o volume de vendas que a rede precisa alcançar.' : 'Organize os parceiros que já fazem parte da sua rede.'}>
      {editor.kind === 'partner' && <PartnerForm partner={editor.partner} data={editor.snapshot} tenant={tenant} saved={saved} />}
      {editor.kind === 'production' && <ProductionForm partner={editor.partner} entry={editor.entry} date={editor.date} today={editor.snapshot.today} saved={saved} />}
      {editor.kind === 'delete' && <DeletePartnerForm partner={editor.partner} saved={saved} cancel={() => setEditor(null)} />}
      {editor.kind === 'goal' && <GoalForm data={editor.snapshot} saved={saved} />}
    </PartnerModal>}
  </main>;
}

function PartnerList({ data, manager, edit, remove }: { data: PartnerDashboard; manager: boolean; edit: (partner: Partner) => void; remove: (partner: Partner) => void }) {
  const [search, setSearch] = useState(''); const [status, setStatus] = useState('all');
  const list = data.partners.filter(p => `${p.name} ${p.contact || ''} ${p.phone || ''}`.toLocaleLowerCase('pt-BR').includes(search.toLocaleLowerCase('pt-BR')) && (status === 'all' || p.active === (status === 'active')));
  return <section className="space-y-4"><div className="flex flex-wrap gap-3"><input aria-label="Buscar parceiro" className={`${fieldClass} max-w-sm`} placeholder="Buscar empresa ou contato" value={search} onChange={e => setSearch(e.target.value)} /><select aria-label="Situação do parceiro" className={`${fieldClass} max-w-[180px]`} value={status} onChange={e => setStatus(e.target.value)}><option value="all">Todos os parceiros</option><option value="active">Ativos</option><option value="inactive">Inativos</option></select></div>
    {!list.length ? <Empty text={data.partners.length ? 'Nenhum parceiro encontrado com esses filtros.' : 'Cadastre o primeiro parceiro para começar a acompanhar as vendas.'} /> : <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/50 text-muted-foreground"><tr>{['Empresa', 'Responsável interno', 'Situação', 'Vendas no mês', ...(manager ? [''] : [])].map((h, i) => <th key={i} className="whitespace-nowrap p-4 font-medium">{h}</th>)}</tr></thead><tbody>{list.map(p => <tr key={p.id} className="border-t"><td className="p-4"><p className="font-medium">{p.name}</p><p className="text-xs text-muted-foreground">{[p.contact, p.phone].filter(Boolean).join(' · ') || 'Sem contato informado'}</p></td><td className="p-4">{p.owner_name || 'Não atribuído'}</td><td className="p-4"><span className={`rounded-full px-2 py-1 text-xs ${p.active ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>{p.active ? 'Ativo' : 'Inativo'}</span></td><td className="whitespace-nowrap p-4 font-semibold">{brl(p.monthly_total)}{!data.entries.some(e => e.partner_id === p.id) && <p className="text-xs font-normal text-muted-foreground">Sem registro no mês</p>}</td>{manager && <td className="p-4"><Button variant="ghost" size="sm" onClick={() => edit(p)}><Pencil className="mr-2 h-3 w-3" />Editar</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(p)}><Trash2 className="mr-2 h-3 w-3" />Excluir</Button></td>}</tr>)}</tbody></table></div>}
  </section>;
}

function Entries({ data, manager, canWrite, edit }: { data: PartnerDashboard; manager: boolean; canWrite: boolean; edit: (partner: Partner, date: string, entry?: Production) => void }) {
  const [partnerId, setPartnerId] = useState(''); const [date, setDate] = useState(data.month === data.today.slice(0, 7) ? data.today : `${data.month}-01`);
  const partner = data.partners.find(p => p.id === partnerId); const current = data.entries.find(e => e.partner_id === partnerId && e.date === date);
  const monthEnd = new Date(Date.UTC(Number(data.month.slice(0, 4)), Number(data.month.slice(5)), 0)).toISOString().slice(0, 10);
  const entries = data.entries.filter(e => !partnerId || e.partner_id === partnerId).slice().sort((a, b) => b.date.localeCompare(a.date));
  const writable = partner && date && date <= data.today && date.startsWith(`${data.month}-`) && (partner.active || (manager && current));
  return <section className="space-y-5">
    <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4"><div className="min-w-[220px] flex-1"><Field label="Empresa"><select className={fieldClass} value={partnerId} onChange={e => setPartnerId(e.target.value)}><option value="">Selecione uma empresa</option>{data.partners.map(p => <option key={p.id} value={p.id}>{p.name}{p.active ? '' : ' (inativo)'}</option>)}</select></Field></div>{canWrite && <><Field label="Dia da venda"><input type="date" className={fieldClass} value={date} min={`${data.month}-01`} max={monthEnd < data.today ? monthEnd : data.today} onChange={e => setDate(e.target.value)} /></Field><Button disabled={!writable} onClick={() => { if (partner && writable) edit(partner, date, current); }}><Plus className="mr-2 h-4 w-4" />{current ? 'Corrigir total do dia' : 'Registrar vendas'}</Button></>}</div>
    <p className="text-sm text-muted-foreground">Registre o total vendido por parceiro a cada dia. Alterar um dia já lançado substitui o total anterior; não soma novamente.</p>
    {!entries.length ? <Empty text="Nenhuma venda registrada neste mês para a seleção atual." /> : <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/50 text-muted-foreground"><tr>{['Data', 'Empresa', 'Vendas', 'Última atualização', ...(canWrite ? [''] : [])].map((h, i) => <th key={i} className="whitespace-nowrap p-4 font-medium">{h}</th>)}</tr></thead><tbody>{entries.map(e => { const p = data.partners.find(item => item.id === e.partner_id); return <tr className="border-t" key={e.id}><td className="whitespace-nowrap p-4">{e.date.split('-').reverse().join('/')}</td><td className="p-4"><p className="font-medium">{p?.name || 'Parceiro'}</p>{e.note && <p className="max-w-xs text-xs text-muted-foreground">{e.note}</p>}</td><td className="whitespace-nowrap p-4 font-semibold">{brl(e.amount)}</td><td className="p-4"><p>{e.updated_by_name}</p><p className="text-xs text-muted-foreground">{new Date(e.updated_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</p></td>{canWrite && <td className="p-4">{p && (p.active || manager) && <Button size="sm" variant="ghost" onClick={() => edit(p, e.date, e)}><Pencil className="mr-2 h-3 w-3" />Corrigir</Button>}</td>}</tr>; })}</tbody></table></div>}
  </section>;
}

function AuditList({ rows, loading, error, partners }: { rows?: PartnerAudit[]; loading: boolean; error: boolean; partners: Partner[] }) {
  if (loading) return <Empty text="Carregando histórico…" />; if (error) return <Empty text="Não foi possível carregar o histórico. Tente atualizar." />;
  const detail = (value: unknown) => { if (!value || typeof value !== 'object') return 'Sem registro anterior'; const v = value as Record<string, unknown>; const parts: string[] = []; if (typeof v.company_name === 'string') parts.push(v.company_name); if (typeof v.consultant_name === 'string') parts.push(v.consultant_name); if (typeof v.occurred_on === 'string') parts.push(v.occurred_on.slice(0,10).split('-').reverse().join('/')); if (typeof v.target === 'number') parts.push(v.target + ' cadastros'); if (typeof v.cancelled === 'boolean') parts.push(v.cancelled ? 'Atividade cancelada' : 'Atividade válida'); if (typeof v.reason === 'string') parts.push(v.reason); if (v.deleted === true) parts.push('Cadastro excluído'); if (typeof v.name === 'string') parts.push(v.name); if (typeof v.amount === 'string' || typeof v.amount === 'number') parts.push(brl(v.amount)); if (typeof v.date === 'string') parts.push(v.date.slice(0, 10).split('-').reverse().join('/')); if (typeof v.month === 'string') parts.push(v.month); if (typeof v.active === 'boolean') parts.push(v.active ? 'Ativo' : 'Inativo'); if (typeof v.note === 'string' && v.note) parts.push(v.note); return parts.join(' · ') || 'Dados cadastrais atualizados'; };
  return <section><h2 className="flex items-center gap-2 font-semibold"><History className="h-4 w-4" />Histórico de alterações</h2><p className="mt-1 text-sm text-muted-foreground">Últimas 100 alterações do workspace, incluindo outros meses.</p>{!rows?.length ? <Empty text="As alterações de parceiros, vendas e metas aparecerão aqui." /> : <div className="mt-5 divide-y rounded-xl border">{rows.map(r => <article key={r.id} className="space-y-1 p-4 text-sm"><p className="font-medium">{r.actor_name} <span className="font-normal text-muted-foreground">· {new Date(r.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</span></p><p>{partners.find(p => p.id === r.entity_id)?.name || (r.action.startsWith('team.activity.') ? 'Atividade da equipe' : r.action.startsWith('team.goal.') ? 'Meta de cadastros por consultora' : r.action === 'partner.deleted' ? 'Parceiro excluído' : r.action.toLowerCase().includes('goal') ? 'Meta mensal' : r.action.toLowerCase().includes('partner') ? 'Cadastro de parceiro' : 'Vendas do parceiro')}</p><p className="text-muted-foreground">Antes: {detail(r.before)}</p><p>Depois: {detail(r.after)}</p></article>)}</div>}</section>;
}
function Empty({ text }: { text: string }) { return <div className="rounded-xl border border-dashed p-12 text-center text-sm text-muted-foreground">{text}</div>; }
