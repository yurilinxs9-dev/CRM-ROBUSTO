'use client';
import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { History, Pencil, Plus, Target, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { brl } from '@/lib/partners';
import { plDate, plError, plSalesKey, type PlDashboard, type PlSale } from '@/lib/pl-sales';
import { Button } from '@/components/ui/button';
import { PartnerModal } from '@/components/partners/partner-forms';
import { PlCancelForm, PlGoalForm, PlSaleForm } from './pl-sales-forms';
import { PlSalesOverview } from './pl-sales-overview';
import { PlSalesHistory } from './pl-sales-history';

type Editor = { kind: 'sale'; sale?: PlSale; snapshot: PlDashboard } | { kind: 'cancel'; sale: PlSale } | { kind: 'goal'; owner: string; snapshot: PlDashboard };

export function PlSalesDashboard({ month, tenant, userId, role }: { month: string; tenant: string; userId: string; role: string }) {
  const qc = useQueryClient();
  const [page, setPage] = useState(1);
  const [view, setView] = useState<'sales' | 'history'>('sales');
  const [editor, setEditor] = useState<Editor | null>(null);
  const saving = useRef(false);
  const query = useQuery({
    queryKey: [...plSalesKey(tenant, userId, role), 'dashboard', month, page],
    queryFn: async ({ signal }) => (await api.get<PlDashboard>('/api/pl-sales', { params: { month, page }, signal })).data,
    refetchInterval: 30000,
  });
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => { void qc.invalidateQueries({ queryKey: plSalesKey(tenant, userId, role) }); };
    socket.on('pl-sales:updated', refresh);
    socket.on('connect', refresh);
    return () => { socket.off('pl-sales:updated', refresh); socket.off('connect', refresh); };
  }, [qc, tenant, userId, role]);
  const total = query.data?.total;
  useEffect(() => { if (total !== undefined && page > Math.max(1, Math.ceil(total / 50))) setPage(Math.max(1, Math.ceil(total / 50))); }, [page, total]);

  async function refresh() {
    setEditor(null);
    await qc.invalidateQueries({ queryKey: plSalesKey(tenant, userId, role) });
  }
  async function saved() {
    toast.success(editor?.kind === 'cancel' ? 'Venda cancelada. Resultados atualizados.' : editor?.kind === 'goal' ? 'Meta salva.' : 'Venda salva. Consulte o mês da data de fechamento.');
    await refresh();
  }
  const formActions = { saved, refresh, onBusy: (busy: boolean) => { saving.current = busy; } };
  const data = query.data;
  const canCreate = data?.members.some(member => data.manager || member.id === userId) ?? false;

  return <section aria-label="Vendas da PL" className="space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-muted/30 p-4 text-sm"><p>Distribua os leads pelo funil <strong>Consórcio PL</strong> no Kanban. Quando um contrato for fechado, registre a venda aqui.</p><Link href="/kanban" className="font-medium text-primary underline underline-offset-4">Abrir Kanban</Link></div>
    {query.isLoading && <p role="status" className="py-16 text-center text-muted-foreground">Carregando as vendas da PL…</p>}
    {query.isError && <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 p-5"><p>Não foi possível carregar as vendas da PL.</p><p className="text-sm text-muted-foreground">{plError(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>}
    {data && !query.isError && <>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap gap-2"><Button variant={view === 'sales' ? 'secondary' : 'ghost'} aria-pressed={view === 'sales'} onClick={() => setView('sales')}>{data.manager ? 'Resultados e contratos' : 'Minhas vendas'}</Button>{data.manager && <Button variant={view === 'history' ? 'secondary' : 'ghost'} aria-pressed={view === 'history'} onClick={() => setView('history')}><History className="mr-2 h-4 w-4" />Histórico da PL</Button>}</div>
        <div className="flex flex-wrap gap-2">{data.manager && <Button variant="outline" onClick={() => setEditor({ kind: 'goal', owner: 'team', snapshot: data })}><Target className="mr-2 h-4 w-4" />Metas do mês</Button>}<Button disabled={!canCreate} onClick={() => setEditor({ kind: 'sale', snapshot: data })}><Plus className="mr-2 h-4 w-4" />Registrar venda</Button></div>
      </div>
      {!canCreate && <p className="text-sm text-muted-foreground">Nenhum vendedor comercial ativo disponível para registrar vendas.</p>}
      {view === 'history' && data.manager ? <PlSalesHistory tenant={tenant} userId={userId} role={role} /> : <>
        <PlSalesOverview data={data} editGoal={owner => setEditor({ kind: 'goal', owner, snapshot: data })} />
        <section className="space-y-3"><div><h2 className="font-semibold">Contratos do mês</h2><p className="mt-1 text-sm text-muted-foreground">{data.total} registro(s), incluindo cancelados. O valor exibido é o crédito contratado, não a comissão.</p></div>
          {!data.sales.length ? <div className="rounded-xl border border-dashed p-10 text-center text-sm text-muted-foreground">Nenhuma venda registrada neste mês{data.manager ? '.' : ' para você.'}</div> : <div className="overflow-x-auto rounded-xl border"><table className="w-full text-left text-sm">
            <thead className="bg-muted/50 text-muted-foreground"><tr>{['Cliente', 'Contrato', 'Fechamento', 'Vendedor', 'Crédito contratado', 'Situação', ...(data.manager ? ['Ações'] : [])].map(label => <th key={label} scope="col" className="whitespace-nowrap p-4 font-medium">{label}</th>)}</tr></thead>
            <tbody>{data.sales.map(sale => <tr key={sale.id} className="border-t">
              <td className="min-w-[180px] p-4"><Link href={`/chat/${sale.lead_id}`} className="font-medium text-primary underline-offset-4 hover:underline">{sale.customer_name}</Link><p className="text-xs text-muted-foreground">{sale.customer_phone}</p>{sale.note && <p className="mt-1 max-w-xs whitespace-pre-wrap break-words text-xs text-muted-foreground">{sale.note}</p>}</td>
              <td className="max-w-[240px] break-words p-4 font-medium">{sale.contract_number}</td><td className="whitespace-nowrap p-4">{plDate(sale.sold_on)}</td><td className="p-4">{sale.seller_name}</td><td className="whitespace-nowrap p-4 font-semibold">{brl(sale.amount)}</td>
              <td className="p-4"><span className={`whitespace-nowrap rounded-full px-2 py-1 text-xs ${sale.status === 'ACTIVE' ? 'bg-emerald-500/10 text-emerald-600' : 'bg-muted text-muted-foreground'}`}>{sale.status === 'ACTIVE' ? 'Ativa' : 'Cancelada'}</span></td>
              {data.manager && <td className="p-4">{sale.status === 'ACTIVE' && <div className="flex gap-1"><Button size="sm" variant="ghost" aria-label={`Corrigir contrato ${sale.contract_number}`} onClick={() => setEditor({ kind: 'sale', sale, snapshot: data })}><Pencil className="mr-2 h-3 w-3" />Corrigir</Button><Button size="sm" variant="ghost" className="text-destructive" aria-label={`Cancelar contrato ${sale.contract_number}`} onClick={() => setEditor({ kind: 'cancel', sale })}><XCircle className="mr-2 h-3 w-3" />Cancelar</Button></div>}</td>}
            </tr>)}</tbody>
          </table></div>}
          <nav aria-label="Páginas dos contratos da PL" className="flex flex-wrap items-center justify-between gap-3"><p className="text-sm text-muted-foreground">Página {data.page} de {Math.max(1, Math.ceil(data.total / 50))}</p><div className="flex gap-2"><Button variant="outline" disabled={page <= 1 || query.isFetching} onClick={() => setPage(current => Math.max(1, current - 1))}>Anterior</Button><Button variant="outline" disabled={!data.hasMore || query.isFetching} onClick={() => setPage(current => current + 1)}>Próxima</Button></div></nav>
        </section>
      </>}
    </>}
    {editor && <PartnerModal close={() => { if (!saving.current) setEditor(null); }} title={editor.kind === 'cancel' ? 'Cancelar venda' : editor.kind === 'goal' ? 'Metas de Vendas da PL' : editor.sale ? 'Corrigir venda' : 'Registrar venda da PL'} description={editor.kind === 'goal' ? 'Metas mensais da equipe e de cada vendedor em crédito contratado.' : editor.kind === 'cancel' ? 'Confira o contrato e informe o motivo do cancelamento.' : 'Vincule a venda a um cliente do Consórcio PL. Valores em crédito contratado (R$).'}>
      {editor.kind === 'sale' && <PlSaleForm sale={editor.sale} data={editor.snapshot} tenant={tenant} userId={userId} role={role} {...formActions} />}
      {editor.kind === 'goal' && <PlGoalForm data={editor.snapshot} initialOwner={editor.owner} {...formActions} />}
      {editor.kind === 'cancel' && <PlCancelForm sale={editor.sale} {...formActions} />}
    </PartnerModal>}
  </section>;
}
