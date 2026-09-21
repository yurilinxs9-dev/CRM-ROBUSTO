'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CalendarDays, CheckCircle2, LockKeyhole, Plus, RefreshCw, Settings2, Wallet, AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { brl, saoPauloDate } from '@/lib/partners';
import { financeError, financeLocked, financeRequest, humanDate, humanMonth, type FinanceAudit, type FinanceCall, type FinanceDashboard, type FinanceHistory, type FinanceInstallment, type FinanceSale } from '@/lib/finance';
import { FinanceModal, financeInput, type FinanceEditor } from './finance-forms';
type Tab = 'overview' | 'timeline' | 'history' | 'sales' | 'audit';
const statusLabel = { received: 'Recebida', overdue: 'Atrasada', pending: 'Pendente' };
export function FinanceWorkspace({ token, lock, expired }: {
    token: string;
    lock: () => Promise<void>;
    expired: () => void;
}) {
    const [month, setMonth] = useState(() => saoPauloDate().slice(0, 7));
    const [months, setMonths] = useState(5);
    const [tab, setTab] = useState<Tab>('overview');
    const [data, setData] = useState<FinanceDashboard | null>(null);
    const [sales, setSales] = useState<FinanceSale[]>([]);
    const [history, setHistory] = useState<FinanceHistory | null>(null);
    const [audit, setAudit] = useState<FinanceAudit[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    const [editor, setEditor] = useState<FinanceEditor | null>(null);
    const [filterMonth, setFilterMonth] = useState('');
    const [filterSale, setFilterSale] = useState('');
    const [filterStatus, setFilterStatus] = useState('all');
    const [page, setPage] = useState(1);
    const [saleSearch, setSaleSearch] = useState('');
    const running = useRef(false);
    const alive = useRef(true);
    const expireRef = useRef(expired);
    expireRef.current = expired;
    const sequence = useRef(0);
    useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
    const call: FinanceCall = useCallback(async <T,>(path: string, method: 'GET' | 'POST' | 'PATCH' = 'GET', body?: unknown, params?: Record<string, string | number | undefined>) => { try {
        return await financeRequest<T>(path, token, method, body, params);
    }
    catch (e) {
        if (financeLocked(e))
            expireRef.current();
        throw e;
    } }, [token]);
    const refresh = useCallback(async (sync = false) => { const seq = ++sequence.current; if (alive.current) {
        setBusy(true);
        setError('');
    } try {
        if (sync)
            await call('sync', 'POST');
        const [d, s] = await Promise.all([call<FinanceDashboard>('dashboard', 'GET', undefined, { month, months }), call<FinanceSale[]>('sales')]);
        if (alive.current && seq === sequence.current) {
            setData(d);
            setSales(s);
        }
    }
    catch (e) {
        if (alive.current && seq === sequence.current)
            setError(financeError(e));
    }
    finally {
        if (alive.current && seq === sequence.current)
            setBusy(false);
    } }, [call, month, months]);
    useEffect(() => { void refresh(true); const interval = setInterval(() => { if (!running.current && document.visibilityState === 'visible') {
        running.current = true;
        void refresh(true).finally(() => { running.current = false; });
    } }, 60000); return () => clearInterval(interval); }, [refresh]);
    const loadHistory = useCallback(async () => { const h = await call<FinanceHistory>('history', 'GET', undefined, { month: filterMonth || undefined, sale_id: filterSale || undefined, status: filterStatus, page }); if (alive.current)
        setHistory(h); }, [call, filterMonth, filterSale, filterStatus, page]);
    useEffect(() => { let current = true; if (tab === 'history') {
        setHistory(null);
        call<FinanceHistory>('history', 'GET', undefined, { month: filterMonth || undefined, sale_id: filterSale || undefined, status: filterStatus, page }).then(h => { if (current)
            setHistory(h); }).catch(e => { if (current)
            setError(financeError(e)); });
    } if (tab === 'audit')
        call<FinanceAudit[]>('audit').then(a => { if (current)
            setAudit(a); }).catch(e => { if (current)
            setError(financeError(e)); }); return () => { current = false; }; }, [call, tab, filterMonth, filterSale, filterStatus, page]);
    async function saved() { setEditor(null); await refresh(); if (tab === 'history')
        await loadHistory(); if (tab === 'audit')
        setAudit(await call<FinanceAudit[]>('audit')); }
    const edit = (row: FinanceInstallment) => setEditor({ kind: 'installment', row });
    const filteredSales = sales.filter(s => s.description.toLocaleLowerCase('pt-BR').includes(saleSearch.toLocaleLowerCase('pt-BR')));
    return <main className="mx-auto max-w-[1600px] space-y-6 p-4 sm:p-6 lg:p-8"><header className="flex flex-wrap items-start justify-between gap-4"><div><p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-600"><LockKeyhole className="h-4 w-4"/>Exclusivo da Paloma</p><h1 className="mt-2 text-3xl font-semibold tracking-tight">Financeiro</h1><p className="mt-2 text-sm text-muted-foreground">Comissões, previsão mensal e controle do que já entrou.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" disabled={busy} onClick={() => void refresh(true)}><RefreshCw className={`mr-2 h-4 w-4 ${busy ? 'animate-spin' : ''}`}/>Atualizar</Button><Button variant="outline" onClick={() => void lock()}><LockKeyhole className="mr-2 h-4 w-4"/>Bloquear</Button><Button onClick={() => setEditor({ kind: 'manual' })}><Plus className="mr-2 h-4 w-4"/>Lançar venda</Button></div></header>
 <div className="flex flex-wrap items-end gap-4 rounded-xl border bg-card p-4"><label className="space-y-1 text-sm"><span>Mês inicial</span><input type="month" min="2000-01" max="2098-12" value={month} onChange={e => { if (/^20\d{2}-(0[1-9]|1[0-2])$/.test(e.target.value))
        setMonth(e.target.value); }} className={financeInput}/></label><label className="space-y-1 text-sm"><span>Projeção</span><select value={months} onChange={e => setMonths(Number(e.target.value))} className={financeInput}>{[3, 5, 6, 12, 24].map(n => <option key={n} value={n}>{n} meses</option>)}</select></label>{data && <Button variant="ghost" onClick={() => setEditor({ kind: 'rule', rule: data.rule })}><Settings2 className="mr-2 h-4 w-4"/>Regra: {(data.rule.total_bps / 100).toLocaleString('pt-BR')}% · {data.rule.distribution.length} parcelas</Button>}</div>
 <nav className="flex flex-wrap gap-1 border-b pb-3" aria-label="Visões do financeiro">{(['overview', 'timeline', 'history', 'sales', 'audit'] as Tab[]).map(t => <Button key={t} variant={tab === t ? 'secondary' : 'ghost'} aria-pressed={tab === t} onClick={() => setTab(t)}>{{ overview: 'Visão geral', timeline: 'Calendário', history: 'Parcelas', sales: 'Vendas', audit: 'Histórico de alterações' }[t]}</Button>)}</nav>
 {error && <div role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">{error}<Button variant="ghost" onClick={() => void refresh(true)}>Tentar novamente</Button></div>}
 {!data && !error && <p role="status" className="py-16 text-center text-muted-foreground">Importando vendas e calculando projeções…</p>}
 {data && <>{data.review_count > 0 && <div className="flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/5 p-4 text-sm"><AlertTriangle className="h-5 w-5 text-amber-600"/><span>{data.review_count} lançamento(s) mudaram na área Parceiros. A projeção mantém os valores anteriores até a conferência.</span><Button variant="outline" size="sm" onClick={() => setTab('sales')}>Conferir vendas</Button></div>}
 {tab === 'overview' && <><section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">{[{ label: `Previsto em ${months} meses`, value: brl(data.projection_total), hint: 'Comissão total dos vencimentos selecionados', icon: Wallet }, { label: 'Ainda a receber no período', value: brl(data.pending_total), hint: 'Parcelas pendentes, incluindo atrasadas', icon: CalendarDays }, { label: 'Recebido no período', value: brl(data.received_total), hint: 'Pela data real em que o dinheiro entrou', icon: CheckCircle2 }, { label: 'Em atraso', value: brl(data.overdue.amount), hint: `${data.overdue.count} parcela(s) de todos os meses`, icon: AlertTriangle }].map(c => <article key={c.label} className="rounded-xl border bg-card p-5"><div className="flex items-center justify-between gap-2 text-sm text-muted-foreground"><span>{c.label}</span><c.icon className="h-4 w-4"/></div><p className="mt-3 text-2xl font-semibold">{c.value}</p><p className="mt-2 text-xs text-muted-foreground">{c.hint}</p></article>)}</section><section className="rounded-xl border bg-card p-5"><h2 className="font-semibold">Previsto × realizado</h2><p className="mt-1 text-sm text-muted-foreground">Previsto pelo vencimento. Realizado pela data real de recebimento, inclusive parcelas de outros meses.</p><div className="mt-5 space-y-4">{data.monthly.map(m => { const max = Math.max(1, ...data.monthly.flatMap(v => [Number(v.expected), Number(v.received)])); return <div key={m.month} className="grid gap-2 sm:grid-cols-[160px_1fr_210px]"><p className="text-sm capitalize">{humanMonth(m.month)}</p><div className="space-y-1.5 py-1" aria-label={`${humanMonth(m.month)}: previsto ${brl(m.expected)}, recebido ${brl(m.received)}`}><div className="h-2.5 rounded bg-blue-500" style={{ width: `${Number(m.expected) / max * 100}%`, minWidth: Number(m.expected) > 0 ? 2 : 0 }}/><div className="h-2.5 rounded bg-emerald-500" style={{ width: `${Number(m.received) / max * 100}%`, minWidth: Number(m.received) > 0 ? 2 : 0 }}/></div><p className="text-xs sm:text-right"><span className="text-blue-600">Previsto {brl(m.expected)}</span><br /><span className="text-emerald-600">Recebido {brl(m.received)}</span></p></div>; })}</div></section><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{data.monthly.map(m => <article key={m.month} className="rounded-xl border p-5"><h3 className="font-medium capitalize">{humanMonth(m.month)}</h3><p className="mt-2 text-xl font-semibold">{brl(m.expected)}</p><p className="text-sm text-muted-foreground">de {m.sales_count} venda(s) / total(is) diário(s)</p><p className="mt-3 text-xs text-muted-foreground">Das parcelas previstas neste mês: {brl(m.settled)} já quitados; {brl(m.pending)} pendentes.</p></article>)}</div></>}
 {tab === 'timeline' && <section className="space-y-4">{data.monthly.map(m => <details key={m.month} className="rounded-xl border bg-card" open={m.month === month}><summary className="cursor-pointer p-5 text-sm"><span className="font-semibold capitalize">{humanMonth(m.month)}</span><span className="ml-3 text-muted-foreground">{m.installments.length} parcelas · {brl(m.expected)} previstos · {brl(m.pending)} pendentes</span></summary><InstallmentTable rows={m.installments} edit={edit}/></details>)}</section>}
 {tab === 'history' && <section className="space-y-4"><div className="grid gap-3 sm:grid-cols-3"><label className="text-sm">Mês de vencimento<input aria-label="Filtrar mês" type="month" className={financeInput} value={filterMonth} onChange={e => { setFilterMonth(e.target.value); setPage(1); }}/></label><label className="text-sm">Venda / lançamento<select className={financeInput} value={filterSale} onChange={e => { setFilterSale(e.target.value); setPage(1); }}><option value="">Todas as vendas</option>{sales.filter(s => !s.cancelled).map(s => <option key={s.id} value={s.id}>{s.description}</option>)}</select></label><label className="text-sm">Situação<select className={financeInput} value={filterStatus} onChange={e => { setFilterStatus(e.target.value); setPage(1); }}><option value="all">Todas</option><option value="pending">Pendentes (inclui atrasadas)</option><option value="received">Recebidas</option><option value="overdue">Atrasadas</option></select></label></div>{history ? <><InstallmentTable rows={history.rows} edit={edit}/><div className="flex items-center justify-between text-sm"><Button variant="outline" disabled={page === 1} onClick={() => setPage(p => p - 1)}>Anterior</Button><span>{history.total} parcelas · página {page}</span><Button variant="outline" disabled={page * 50 >= history.total} onClick={() => setPage(p => p + 1)}>Próxima</Button></div></> : <p role="status">Carregando parcelas…</p>}</section>}
 {tab === 'sales' && <section className="space-y-4"><p className="text-sm text-muted-foreground">As vendas de Parceiros entram automaticamente. Lançamentos manuais ficam apenas neste financeiro. Não cadastre novamente uma venda já importada.</p><input aria-label="Buscar venda" placeholder="Buscar identificação da venda" className={`${financeInput} max-w-sm`} value={saleSearch} onChange={e => setSaleSearch(e.target.value)}/>{!filteredSales.length ? <Empty text="Nenhuma venda encontrada. Use Lançar venda ou registre vendas na área Parceiros."/> : <div className="overflow-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['Venda / lançamento', 'Origem', 'Fechamento', 'Valor vendido', 'Comissão', 'Ações'].map(h => <th key={h} className="p-4 font-medium">{h}</th>)}</tr></thead><tbody>{filteredSales.map(s => <tr key={s.id} className="border-t"><td className="p-4"><p className="font-medium">{s.description}</p>{s.cancelled && <p className="text-xs text-muted-foreground">Cancelada — fora da projeção</p>}{s.needs_review && <p className="text-xs text-amber-600">Origem alterada: conferir</p>}</td><td className="p-4">{s.source_type === 'partner' ? 'Parceiros · total diário' : 'Manual'}</td><td className="whitespace-nowrap p-4">{humanDate(s.closed_on)}</td><td className="whitespace-nowrap p-4">{brl(s.amount)}</td><td className="whitespace-nowrap p-4">{brl(s.commission_total)}<p className="text-xs text-muted-foreground">{s.installment_count} parcelas</p></td><td className="p-3"><div className="flex flex-wrap gap-1">{!s.cancelled && <Button variant="ghost" size="sm" onClick={() => { setFilterSale(s.id); setFilterMonth(''); setFilterStatus('all'); setPage(1); setTab('history'); }}>Ver parcelas</Button>}{s.source_type === 'manual' && !s.cancelled && <><Button variant="ghost" size="sm" onClick={() => setEditor({ kind: 'manual', sale: s })}>Editar</Button><Button variant="ghost" size="sm" className="text-destructive" onClick={() => setEditor({ kind: 'cancel', sale: s })}>Cancelar</Button></>}{s.needs_review && <Button variant="outline" size="sm" onClick={() => setEditor({ kind: 'reconcile', sale: s })}>Conferir origem</Button>}</div></td></tr>)}</tbody></table></div>}</section>}
 {tab === 'audit' && <section className="space-y-3"><p className="text-sm text-muted-foreground">Últimas 100 alterações e acessos. Exclusivo da Paloma.</p>{!audit.length ? <Empty text="Nenhum evento carregado."/> : audit.map(a => <article key={a.id} className="rounded-xl border p-4 text-sm"><p className="font-medium">{auditName(a.action)} <span className="font-normal text-muted-foreground">· {new Date(a.created_at).toLocaleString('pt-BR')}</span></p><p className="mt-1 text-xs text-muted-foreground">Registro: {a.entity_id}</p><details className="mt-2"><summary className="cursor-pointer">Ver antes e depois</summary><div className="mt-2 grid gap-3 sm:grid-cols-2"><div><p className="font-medium">Antes</p><AuditValues value={a.before}/></div><div><p className="font-medium">Depois</p><AuditValues value={a.after}/></div></div></details></article>)}</section>}
 <p className="text-xs text-muted-foreground">Vencimento padrão: último dia do mês. Para ajustar a data ou marcar um recebimento, abra a parcela. O fechamento mensal considera America/Sao_Paulo.</p>
 {editor && <FinanceModal editor={editor} call={call} today={data.today} close={() => setEditor(null)} saved={saved}/>}
 </>}
 </main>;
}
function InstallmentTable({ rows, edit }: {
    rows: FinanceInstallment[];
    edit: (r: FinanceInstallment) => void;
}) { if (!rows.length)
    return <Empty text="Nenhuma parcela neste período ou filtro."/>; return <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm"><thead className="bg-muted/50"><tr>{['Venda / lançamento', 'Parcela', 'Vencimento', 'Valor esperado', 'Situação', ''].map((h, i) => <th key={i} className="whitespace-nowrap p-4 font-medium">{h}</th>)}</tr></thead><tbody>{rows.map(r => <tr key={r.id} className="border-t"><td className="p-4"><p className="max-w-md font-medium">{r.description}</p><p className="text-xs text-muted-foreground">{r.source_type === 'partner' ? 'Importado de Parceiros' : 'Venda manual'}</p></td><td className="p-4">{r.number}ª <span className="text-xs text-muted-foreground">({(r.rate_bps / 100).toLocaleString('pt-BR')}%)</span></td><td className="whitespace-nowrap p-4">{humanDate(r.due_on)}{r.due_overridden && <p className="text-xs text-muted-foreground">Data ajustada</p>}</td><td className="whitespace-nowrap p-4 font-semibold">{brl(r.amount)}</td><td className="p-4"><span className={`rounded-full px-2 py-1 text-xs ${r.status === 'received' ? 'bg-emerald-500/10 text-emerald-600' : r.status === 'overdue' ? 'bg-red-500/10 text-red-600' : 'bg-muted text-muted-foreground'}`}>{statusLabel[r.status]}</span>{r.received_on && <p className="mt-2 text-xs text-muted-foreground">{humanDate(r.received_on)}</p>}</td><td className="p-4"><Button size="sm" variant="outline" onClick={() => edit(r)}>{r.received_on ? 'Ver / corrigir' : 'Receber / ajustar'}</Button></td></tr>)}</tbody></table></div>; }
function Empty({ text }: {
    text: string;
}) { return <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">{text}</div>; }
function auditName(action: string) { return ({ 'sale.created': 'Venda registrada', 'sale.updated': 'Venda alterada', 'sale.cancelled': 'Venda cancelada', 'rule.changed': 'Regra de comissão alterada', 'source.changed': 'Mudança na origem detectada', 'source.reconciled': 'Venda conciliada com a origem', 'installment.updated': 'Parcela atualizada', 'access.created': 'Senha financeira criada', 'access.reset': 'Senha financeira redefinida', 'access.login': 'Acesso ao financeiro' } as Record<string, string>)[action] ?? action; }
function AuditValues({ value }: {
    value: unknown;
}) { if (!value || typeof value !== 'object')
    return <p className="text-xs text-muted-foreground">Sem registro anterior</p>; const v = value as Record<string, unknown>; const lines: string[] = []; if (typeof v.description === 'string')
    lines.push(v.description); for (const key of ['amount', 'commission_total'])
    if (typeof v[key] === 'string' || typeof v[key] === 'number')
        lines.push((key === 'amount' ? 'Valor: ' : 'Comissão: ') + brl(v[key] as string | number)); for (const key of ['closed_on', 'due_on', 'received_on'])
    if (typeof v[key] === 'string')
        lines.push(({ closed_on: 'Fechamento: ', due_on: 'Vencimento: ', received_on: 'Recebimento: ' } as Record<string, string>)[key] + humanDate((v[key] as string).slice(0, 10))); if ('received_on' in v && v.received_on === null)
    lines.push('Recebimento: pendente'); if (typeof v.total_bps === 'number')
    lines.push(`Comissão total: ${v.total_bps / 100}%`); if (Array.isArray(v.distribution))
    lines.push('Distribuição: ' + v.distribution.map(x => Number(x) / 100 + '%').join(' / ')); if (v.cancelled === true)
    lines.push('Cancelada'); if (v.configured === true)
    lines.push('Acesso configurado'); return <ul className="space-y-1 text-xs text-muted-foreground">{(lines.length ? lines : ['Alteração registrada']).map((s, i) => <li key={i}>{s}</li>)}</ul>; }
