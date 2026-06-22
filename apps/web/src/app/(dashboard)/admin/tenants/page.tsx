'use client';

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Search, ChevronRight, Trash2 } from 'lucide-react';
import { api } from '@/lib/api';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { CopyId } from '@/components/ui/copy-id';

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
}

type Tab = 'connected' | 'disconnected' | 'all';

const numberFmt = new Intl.NumberFormat('pt-BR');
const isConnected = (t: TenantRow) => t.active_instances > 0;

export default function AdminTenantsPage() {
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<Tab>('connected');
  const qc = useQueryClient();

  const { data = [], isLoading } = useQuery<TenantRow[]>({
    queryKey: ['admin-tenants'],
    queryFn: async () => (await api.get<TenantRow[]>('/api/platform-admin/tenants')).data,
  });

  const deleteTenant = useMutation({
    mutationFn: async (id: string) => api.delete(`/api/platform-admin/tenants/${id}`),
    onSuccess: () => { toast.success('Cliente excluído'); qc.invalidateQueries({ queryKey: ['admin-tenants'] }); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao excluir'),
  });

  const connectedCount = useMemo(() => data.filter(isConnected).length, [data]);
  const disconnectedCount = data.length - connectedCount;

  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    let rows = data;
    if (tab === 'connected') rows = rows.filter(isConnected);
    else if (tab === 'disconnected') rows = rows.filter((t) => !isConnected(t));
    if (!term) return rows;
    return rows.filter(
      (t) =>
        t.nome.toLowerCase().includes(term) ||
        t.id.toLowerCase().includes(term) ||
        t.owner?.email.toLowerCase().includes(term) ||
        t.owner?.nome.toLowerCase().includes(term),
    );
  }, [data, q, tab]);

  const askDelete = (t: TenantRow) => {
    const typed = window.prompt(
      `EXCLUSÃO TOTAL e irreversível do cliente "${t.nome}":\n` +
        `${numberFmt.format(t.users)} usuário(s), ${numberFmt.format(t.leads)} lead(s), ${numberFmt.format(t.instances)} instância(s) serão apagados.\n\n` +
        `Para confirmar, digite o nome do cliente:`,
    );
    if (typed === null) return;
    if (typed.trim() !== t.nome.trim()) { toast.error('Nome não confere — exclusão cancelada'); return; }
    deleteTenant.mutate(t.id);
  };

  const tabs: { key: Tab; label: string; count: number }[] = [
    { key: 'connected', label: 'Conectados', count: connectedCount },
    { key: 'disconnected', label: 'Desconectados', count: disconnectedCount },
    { key: 'all', label: 'Todos', count: data.length },
  ];

  return (
    <div className="space-y-4">
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
                  {['Cliente', 'ID', 'Owner', 'Modelo', 'Usuários', 'Leads', 'Instâncias', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr key={t.id} className="hover:bg-accent/40 transition-colors" style={{ borderBottom: '1px solid var(--border-default)' }}>
                    <td className="px-3 py-3">
                      <Link href={`/admin/tenants/${t.id}`} className="font-medium hover:underline" style={{ color: 'var(--text-primary)' }}>{t.nome}</Link>
                    </td>
                    <td className="px-3 py-3">
                      <CopyId value={t.id} />
                    </td>
                    <td className="px-3 py-3" style={{ color: 'var(--text-secondary)' }}>
                      <div className="truncate max-w-[200px]">{t.owner?.nome ?? '—'}</div>
                      <div className="truncate max-w-[200px] text-xs text-muted-foreground">{t.owner?.email ?? ''}</div>
                    </td>
                    <td className="px-3 py-3 text-xs" style={{ color: 'var(--text-secondary)' }}>{t.pool_enabled ? 'Compartilhado' : 'Individual'}</td>
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
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          title="Excluir cliente totalmente"
                          disabled={deleteTenant.isPending}
                          onClick={() => askDelete(t)}
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
    </div>
  );
}
