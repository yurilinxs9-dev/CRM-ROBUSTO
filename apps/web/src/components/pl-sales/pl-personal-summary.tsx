'use client';

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { brl, saoPauloDate } from '@/lib/partners';
import { plMonth, plPercentage, plSalesKey, type PlDashboard } from '@/lib/pl-sales';
import { isPlSalesOnly } from '@/lib/pl-sales-access';
import { useAuthStore } from '@/stores/auth.store';
import { Button } from '@/components/ui/button';

/** Confirmed monthly sales; independent of Analytics' lead date range. */
export function PlPersonalSummary() {
  const user = useAuthStore(state => state.user);
  const restricted = isPlSalesOnly(user);
  const currentMonth = saoPauloDate().slice(0, 7);
  const [month, setMonth] = useState(currentMonth);
  const tenant = user?.tenantId ?? '';
  const userId = user?.id ?? '';
  const role = user?.role ?? '';
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: [...plSalesKey(tenant, userId, role), 'personal-summary', restricted, month],
    queryFn: async ({ signal }) => {
      const { data } = await api.get<PlDashboard>('/api/pl-sales', { params: { month, page: 1 }, signal });
      if (data.manager !== false) throw new Error('Relatório individual indisponível.');
      return data.summary;
    },
    enabled: !!user && restricted,
    refetchInterval: 30_000,
    refetchOnMount: 'always',
    refetchOnWindowFocus: 'always',
    refetchOnReconnect: 'always',
  });
  useEffect(() => {
    const socket = getSocket();
    const refresh = () => { void qc.invalidateQueries({ queryKey: plSalesKey(tenant, userId, role) }); };
    socket.on('pl-sales:updated', refresh);
    socket.on('connect', refresh);
    return () => { socket.off('pl-sales:updated', refresh); socket.off('connect', refresh); };
  }, [qc, tenant, userId, role]);

  const summary = query.data;
  const percentage = summary?.percentage;
  return <section aria-label="Minhas vendas e meta mensal" className="space-y-4 rounded-xl border bg-card p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div><h3 className="font-semibold">Minhas vendas e meta mensal</h3><p className="mt-1 text-sm text-muted-foreground">Contratos ativos de {plMonth(month)}. Valores de crédito contratado registrados em Vendas da PL.</p></div>
      <label className="flex flex-col gap-1 text-xs text-muted-foreground">Mês das vendas e da meta
        <input type="month" value={month} max={currentMonth} className="rounded-md border bg-background px-3 py-2 text-sm text-foreground" onChange={event => {
          const value = event.target.value;
          if (/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && value <= currentMonth) setMonth(value);
        }} />
      </label>
    </div>
    <p className="text-xs text-muted-foreground">Este mês é independente do período de leads e atendimento. Somente suas vendas e sua meta individual; cancelamentos não entram no resultado.</p>
    {query.isLoading && <p role="status" className="text-sm text-muted-foreground">Carregando suas vendas e meta…</p>}
    {query.isError && <div role="alert" className="space-y-2 text-sm"><p>Não foi possível carregar suas vendas e meta.</p><Button variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></div>}
    {summary && !query.isError && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
        { label: 'Meu crédito contratado', value: brl(summary.total) },
        { label: 'Meus contratos ativos', value: String(summary.contracts) },
        { label: 'Minha meta', value: summary.target === null ? 'Não definida' : brl(summary.target) },
        { label: 'Falta para minha meta', value: summary.remaining === null ? '—' : brl(summary.remaining) },
      ].map(card => <div key={card.label}><p className="text-sm text-muted-foreground">{card.label}</p><p className="mt-2 break-words text-2xl font-semibold">{card.value}</p></div>)}</div>
      {percentage != null && Number.isFinite(percentage) && <div>
        <p className="mb-2 text-sm">{plPercentage(percentage)} da minha meta alcançada</p>
        <div role="progressbar" aria-label="Progresso da minha meta" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.min(100, Math.max(0, percentage))} aria-valuetext={`${plPercentage(percentage)} da meta`} className="h-2 overflow-hidden rounded-full bg-muted"><div className="h-full bg-emerald-500" style={{ width: `${Math.min(100, Math.max(0, percentage))}%` }} /></div>
      </div>}
      {summary.target === null && <p className="text-xs text-muted-foreground">Sua meta ainda não foi definida pela gestão.</p>}
      {summary.target !== null && Number(summary.target) === 0 && <p className="text-xs text-muted-foreground">Meta definida em R$ 0,00; percentual não se aplica.</p>}
    </>}
  </section>;
}
