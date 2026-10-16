'use client';
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { plAuditDetail, plError, plSalesKey, type PlAudit } from '@/lib/pl-sales';
import { Button } from '@/components/ui/button';

const actions: Record<string, string> = { 'sale.created': 'Venda registrada', 'sale.updated': 'Venda corrigida', 'sale.cancelled': 'Venda cancelada', 'goal.saved': 'Meta salva' };

export function PlSalesHistory({ tenant, userId, role }: { tenant: string; userId: string; role: string }) {
  const query = useQuery({
    queryKey: [...plSalesKey(tenant, userId, role), 'audit'],
    queryFn: async ({ signal }) => (await api.get<PlAudit[]>('/api/pl-sales/audit', { signal })).data,
  });
  return <section className="space-y-4">
    <div><h2 className="font-semibold">Histórico de Vendas da PL</h2><p className="mt-1 text-sm text-muted-foreground">Últimas 100 alterações de vendas e metas, incluindo outros meses. Horários de Brasília.</p></div>
    {query.isLoading && <p role="status" className="py-8 text-center text-sm text-muted-foreground">Carregando histórico…</p>}
    {query.isError && <div role="alert" className="space-y-3 rounded-xl border border-destructive/30 p-4"><p>{plError(query.error)}</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>}
    {!query.isError && query.data && (query.data.length ? <div className="divide-y rounded-xl border">{query.data.map(row => <article key={row.id} className="space-y-2 break-words p-4 text-sm">
      <p className="font-semibold">{actions[row.action] ?? 'Registro atualizado'}</p><p>{row.actor_name} <span className="text-muted-foreground">· {new Date(row.created_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}</span></p>
      <p className="whitespace-pre-wrap text-muted-foreground">Antes: {plAuditDetail(row.before)}</p><p className="whitespace-pre-wrap">Depois: {plAuditDetail(row.after)}</p>
    </article>)}</div> : <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">As alterações de vendas e metas da PL aparecerão aqui.</div>)}
  </section>;
}
