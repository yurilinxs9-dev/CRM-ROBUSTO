'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, ChevronRight, Trash2, LogIn, Power, BadgeCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { CopyId } from '@/components/ui/copy-id';
import {
  BillingBadge, DeleteTenantDialog, moneyFmt, billingPhrase, billingDateFmt, type BillingInfo,
} from './billing-ui';

interface TenantRow {
  id: string;
  nome: string;
  pool_enabled: boolean;
  created_at: string;
  owner: { id: string; nome: string; email: string } | null;
  users: number;
  leads: number;
  instances: number;
  active_instances: number;
  billing_value: number | null;
  billing_cycle_months: number | null;
  billing_paid_until: string | null;
  suspended: boolean;
  billing: BillingInfo;
}

interface BillingSummary {
  receita_mensal_esperada: number;
  em_dia: { qtde: number; valor_mensal: number };
  vence_em_breve: { qtde: number; valor_mensal: number };
  vencidos: { qtde: number; valor_mensal: number };
  suspensos: number;
}

type Tab = 'connected' | 'disconnected' | 'overdue' | 'all';

const numberFmt = new Intl.NumberFormat('pt-BR');
const isConnected = (t: TenantRow) => t.active_instances > 0;

export default function AdminTenantsPage() {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('connected');
  const [deleteTarget, setDeleteTarget] = useState<TenantRow | null>(null);
  const qc = useQueryClient();
  const startImpersonation = useAuthStore((s) => s.startImpersonation);

  const { data = [], isLoading } = useQuery<TenantRow[]>({
    queryKey: ['admin-tenants'],
    queryFn: async () => (await api.get<TenantRow[]>('/api/platform-admin/tenants')).data,
  });

  const { data: summary } = useQuery<BillingSummary>({
    queryKey: ['admin-billing-summary'],
    queryFn: async () => (await api.get<BillingSummary>('/api/platform-admin/billing-summary')).data,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['admin-tenants'] });
    qc.invalidateQueries({ queryKey: ['admin-billing-summary'] });
  };

  const deleteTenant = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/platform-admin/tenants/${id}`),
    onSuccess: () => { toast.success('Cliente excluído'); setDeleteTarget(null); invalidate(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao excluir'),
  });

  const markPaid = useMutation({
    mutationFn: async (id: string) =>
      (await api.post<{ ok: boolean; paid_until: string }>(`/api/platform-admin/tenants/${id}/billing/mark-paid`)).data,
    onSuccess: (res) => {
      toast.success(`Pago até ${new Date(res.paid_until).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`);
      invalidate();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao marcar pago'),
  });

  const suspendTenant = useMutation({
    mutationFn: async ({ id, suspended }: { id: string; suspended: boolean }) =>
      api.patch(`/api/platform-admin/tenants/${id}/suspend`, { suspended }),
    onSuccess: (_d, v) => { toast.success(v.suspended ? 'Workspace suspenso' : 'Workspace reativado'); invalidate(); },
    onError: () => toast.error('Falha ao suspender'),
  });

  const impersonate = useMutation({
    mutationFn: async (userId: string) =>
      (await api.post<{ accessToken: string; user: { id: string; nome: string; email: string; role: string; tenantId: string } }>(`/api/platform-admin/impersonate/${userId}`)).data,
    onSuccess: (res) => {
      startImpersonation(res.user, res.accessToken);
      toast.success(`Entrando como ${res.user.nome}`);
      window.location.href = '/dashboard';
    },
    onError: () => toast.error('Falha ao entrar como usuário'),
  });

  const connectedCount = useMemo(() => data.filter(isConnected).length, [data]);
  const disconnectedCount = data.length - connectedCount;
  const overdueCount = useMemo(() => data.filter((t) => t.billing.status === 'vencido').length, [data]);

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = data;
    if (tab === 'connected') rows = rows.filter(isConnected);
    else if (tab === 'disconnected') rows = rows.filter((t) => !isConnected(t));
    else if (tab === 'overdue') rows = rows.filter((t) => t.billing.status === 'vencido');
    if (!term) return rows;
    return rows.filter(
      (t) =>
        t.nome.toLowerCase().includes(term) ||
        t.id.toLowerCase().includes(term) ||
        t.owner?.email.toLowerCase().includes(term) ||
        t.owner?.nome.toLowerCase().includes(term),
    );
  }, [data, q, tab]);

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'connected', label: 'Conectados', count: connectedCount },
    { key: 'disconnected', label: 'Desconectados', count: disconnectedCount },
    { key: 'overdue', label: 'Vencidos', count: overdueCount },
    { key: 'all', label: 'Todos', count: data.length },
  ];

  const kpi = (label: string, value: string, sub?: string, color?: string) => (
    <div className="rounded-xl border px-4 py-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
      <p className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p className="text-lg font-semibold tabular-nums" style={{ color: color ?? 'var(--text-primary)' }}>{value}</p>
      {sub && <p className="text-[11px]" style={{ color: 'var(--text-muted)' }}>{sub}</p>}
    </div>
  );

  return (
    <div className="space-y-4">
      {summary && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {kpi('Receita mensal esperada', moneyFmt(summary.receita_mensal_esperada))}
          {kpi('Em dia', String(summary.em_dia.qtde), moneyFmt(summary.em_dia.valor_mensal) + '/mês', '#22c55e')}
          {kpi('Vencidos', String(summary.vencidos.qtde), moneyFmt(summary.vencidos.valor_mensal) + '/mês', summary.vencidos.qtde > 0 ? '#ef4444' : undefined)}
          {kpi('Suspensos', String(summary.suspensos))}
        </div>
      )}

      <div className="flex items-center gap-1 border-b" style={{ borderColor: 'var(--border-default)' }}>
        {tabs.map((tb) => (
          <button
            key={tb.key}
            type="button"
            onClick={() => setTab(tb.key)}
            className="relative px-3 py-2 text-sm font-medium transition-colors"
            style={{ color: tab === tb.key ? 'var(--text-primary)' : 'var(--text-muted)' }}
          >
            {tb.label}
            <span className="ml-1.5 text-xs tabular-nums" style={{ color: 'var(--text-muted)' }}>{tb.count}</span>
            {tab === tb.key && <span className="absolute inset-x-2 -bottom-px h-0.5 rounded-full" style={{ background: 'var(--primary)' }} />}
          </button>
        ))}
      </div>

      <div className="relative max-w-sm">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Buscar cliente, owner ou ID..." className="pl-9" autoComplete="off" />
      </div>

      {isLoading ? (
        <div className="space-y-2">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-16 w-full rounded-lg" />)}</div>
      ) : (
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)' }}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-default)' }}>
                  {['Cliente', 'ID', 'Owner', 'Pagamento', 'Usuários', 'Leads', 'Instâncias', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className={`hover:bg-accent/40 transition-colors${t.suspended ? ' opacity-60' : ''}`} style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1.5">
                        <Link href={`/admin/tenants/${t.id}`} className="font-medium hover:underline" style={{ color: 'var(--text-primary)' }}>{t.nome}</Link>
                        {t.suspended && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>SUSPENSO</span>}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <CopyId value={t.id} />
                    </td>
                    <td className="px-3 py-3" style={{ color: 'var(--text-secondary)' }}>
                      <div className="truncate max-w-[200px]">{t.owner?.nome ?? '—'}</div>
                      <div className="truncate max-w-[200px] text-xs text-muted-foreground">{t.owner?.email ?? ''}</div>
                    </td>
                    <td className="px-3 py-3" title={t.billing_value != null ? `${moneyFmt(t.billing_value)} / ${t.billing_cycle_months ?? 1} mês(es)` : undefined}>
                      <BillingBadge billing={t.billing} title={billingPhrase(t.billing, t.billing_paid_until)} />
                      {t.billing.status !== 'sem_cobranca' && t.billing_paid_until && (
                        <div className="mt-0.5 text-[11px] whitespace-nowrap" style={{ color: 'var(--text-muted)' }}>
                          {t.billing.status === 'vencido' ? 'venceu' : 'vence'} {billingDateFmt(t.billing_paid_until, true)}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>{numberFmt.format(t.users)}</td>
                    <td className="px-3 py-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>{numberFmt.format(t.leads)}</td>
                    <td className="px-3 py-3">
                      <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
                        <span className="h-2 w-2 rounded-full" style={{ background: t.active_instances > 0 ? '#22c55e' : t.instances > 0 ? '#ef4444' : '#6b7280' }} />
                        {t.active_instances > 0 ? `${t.active_instances} ativa(s)` : t.instances > 0 ? 'desconectado' : 'sem instância'}
                      </span>
                    </td>
                    <td className="px-3 py-3">
                      <div className="flex items-center justify-end gap-1">
                        {t.billing.status !== 'sem_cobranca' && (
                          <Button
                            size="icon" variant="ghost" className="h-7 w-7"
                            title={`Marcar pago (+${t.billing_cycle_months ?? 1} mês/es)`}
                            disabled={markPaid.isPending}
                            onClick={() => markPaid.mutate(t.id)}
                          >
                            <BadgeCheck className="h-3.5 w-3.5 text-emerald-500" />
                          </Button>
                        )}
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          title={t.suspended ? 'Reativar workspace' : 'Suspender workspace'}
                          disabled={suspendTenant.isPending}
                          onClick={() => {
                            if (confirm(t.suspended ? `Reativar workspace "${t.nome}"?` : `Suspender "${t.nome}"? Login, recebimento e envio param imediatamente.`)) {
                              suspendTenant.mutate({ id: t.id, suspended: !t.suspended });
                            }
                          }}
                        >
                          <Power className={`h-3.5 w-3.5 ${t.suspended ? 'text-emerald-500' : 'text-amber-500'}`} />
                        </Button>
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          title={t.owner ? `Entrar como ${t.owner.nome}` : 'Sem owner para impersonar'}
                          disabled={!t.owner || impersonate.isPending}
                          onClick={() => t.owner && impersonate.mutate(t.owner.id)}
                        >
                          <LogIn className="h-3.5 w-3.5" />
                        </Button>
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          title="Excluir cliente totalmente"
                          disabled={deleteTenant.isPending}
                          onClick={() => setDeleteTarget(t)}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                        <Link href={`/admin/tenants/${t.id}`} className="inline-flex text-muted-foreground hover:text-foreground"><ChevronRight className="h-4 w-4" /></Link>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={8} className="px-3 py-10 text-center text-muted-foreground">Nenhum cliente.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {deleteTarget && (
        <DeleteTenantDialog
          open
          onOpenChange={(v) => { if (!v) setDeleteTarget(null); }}
          nome={deleteTarget.nome}
          counts={{ users: deleteTarget.users, leads: deleteTarget.leads, instances: deleteTarget.instances }}
          pending={deleteTenant.isPending}
          onConfirm={() => deleteTenant.mutate(deleteTarget.id)}
        />
      )}
    </div>
  );
}
