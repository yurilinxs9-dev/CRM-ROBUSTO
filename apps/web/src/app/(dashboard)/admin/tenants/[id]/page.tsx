'use client';

import { useState } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, LogIn, Smartphone, Users, Contact, MessageSquare, Ban, Trash2, ShieldCheck, Power, BadgeCheck } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CopyId } from '@/components/ui/copy-id';
import { BillingBadge, DeleteTenantDialog, moneyFmt, type BillingInfo } from '../billing-ui';

interface TenantUser {
  id: string; nome: string; email: string; role: string; ativo: boolean; is_platform_admin: boolean;
}
interface TenantInstance { id: string; nome: string; status: string; telefone?: string | null }
interface TenantDetail {
  id: string; nome: string; pool_enabled: boolean; prefix_enabled: boolean; created_at: string;
  billing_value: number | null; billing_cycle_months: number | null; billing_paid_until: string | null;
  suspended_at: string | null;
  owner: { id: string; nome: string; email: string } | null;
  users: TenantUser[];
  instances: TenantInstance[];
  counts: { leads: number; messages: number; users: number };
}

const numberFmt = new Intl.NumberFormat('pt-BR');
const liveStatus = (s: string) => ['open', 'connected', 'connecting'].includes(s);

// Mesma régua do backend (billing-status.ts): <0 vencido, ≤3 vence em breve.
function deriveClient(t: { billing_value: number | null; billing_paid_until: string | null }): BillingInfo {
  if (t.billing_value == null || !t.billing_paid_until) return { status: 'sem_cobranca', dias: 0 };
  const day = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());
  const diff = Math.round((day(new Date(t.billing_paid_until)) - day(new Date())) / 86_400_000);
  if (diff < 0) return { status: 'vencido', dias: -diff };
  if (diff <= 3) return { status: 'vence_em_breve', dias: diff };
  return { status: 'em_dia', dias: diff };
}

export default function AdminTenantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const qc = useQueryClient();
  const startImpersonation = useAuthStore((s) => s.startImpersonation);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const { data, isLoading } = useQuery<TenantDetail>({
    queryKey: ['admin-tenant', id],
    queryFn: async () => (await api.get<TenantDetail>(`/api/platform-admin/tenants/${id}`)).data,
    enabled: !!id,
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

  const invalidate = () => qc.invalidateQueries({ queryKey: ['admin-tenant', id] });

  const banUser = useMutation({
    mutationFn: async ({ userId, banned }: { userId: string; banned: boolean }) =>
      api.patch(`/api/platform-admin/users/${userId}/ban`, { banned }),
    onSuccess: (_d, v) => { toast.success(v.banned ? 'Usuário banido' : 'Usuário reativado'); invalidate(); },
    onError: () => toast.error('Falha na ação'),
  });
  const deleteUser = useMutation({
    mutationFn: async (userId: string) => api.delete(`/api/platform-admin/users/${userId}`),
    onSuccess: () => { toast.success('Usuário excluído'); invalidate(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao excluir'),
  });
  const suspendTenant = useMutation({
    mutationFn: async (suspended: boolean) => api.patch(`/api/platform-admin/tenants/${id}/suspend`, { suspended }),
    onSuccess: (_d, suspended) => { toast.success(suspended ? 'Workspace suspenso' : 'Workspace reativado'); invalidate(); },
    onError: () => toast.error('Falha ao suspender'),
  });
  const deleteTenant = useMutation({
    mutationFn: async () => api.delete(`/api/platform-admin/tenants/${id}`),
    onSuccess: () => { toast.success('Cliente excluído'); router.push('/admin/tenants'); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao excluir'),
  });

  if (isLoading || !data) {
    return <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full rounded-xl" /></div>;
  }

  // suspended_at é a fonte nova; fallback users-inativos cobre tenants suspensos
  // antes do campo existir (backfill pode não ter rodado em todos).
  const suspended = data.suspended_at != null || (data.users.length > 0 && data.users.every((u) => !u.ativo));
  const ownerId = data.owner?.id;

  const stat = (icon: typeof Users, label: string, value: number) => (
    <div className="rounded-lg border px-3 py-2 flex items-center gap-2" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
      {(() => { const I = icon; return <I size={15} style={{ color: 'var(--primary)' }} />; })()}
      <span className="text-sm tabular-nums" style={{ color: 'var(--text-primary)' }}>{numberFmt.format(value)}</span>
      <span className="text-xs" style={{ color: 'var(--text-muted)' }}>{label}</span>
    </div>
  );

  return (
    <div className="space-y-5">
      <button type="button" onClick={() => router.push('/admin/tenants')} className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-4 w-4" /> Clientes
      </button>

      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-semibold flex items-center gap-2" style={{ color: 'var(--text-primary)' }}>
            {data.nome}
            <BillingBadge billing={deriveClient(data)} />
            {suspended && <span className="text-[10px] rounded px-1.5 py-0.5" style={{ background: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>SUSPENSO</span>}
          </h3>
          <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
            Owner: {data.owner?.nome} ({data.owner?.email}) · {data.pool_enabled ? 'Compartilhado' : 'Individual'}
          </p>
          <div className="mt-1">
            <CopyId value={data.id} label="Tenant ID:" full />
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs"
            disabled={suspendTenant.isPending}
            onClick={() => {
              if (confirm(suspended ? `Reativar workspace "${data.nome}"?` : `Suspender "${data.nome}"? Todos os usuários ficam sem acesso.`)) {
                suspendTenant.mutate(!suspended);
              }
            }}
          >
            <Power className="mr-1 h-3.5 w-3.5" /> {suspended ? 'Reativar workspace' : 'Suspender workspace'}
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-8 text-xs border-red-500/40 text-red-500 hover:bg-red-500/10"
            disabled={deleteTenant.isPending}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" /> Excluir cliente
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {stat(Users, 'usuários', data.counts.users)}
        {stat(Contact, 'leads', data.counts.leads)}
        {stat(MessageSquare, 'mensagens', data.counts.messages)}
        {stat(Smartphone, 'instâncias', data.instances.length)}
      </div>

      {/* Cobrança */}
      <BillingCard
        key={`${data.billing_value}-${data.billing_cycle_months}-${data.billing_paid_until}`}
        tenantId={id}
        billing={data}
        onChanged={invalidate}
      />

      {/* Equipe */}
      <div>
        <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Equipe</h4>
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-default)' }}>
                {['Nome', 'Email', 'ID', 'Papel', 'Status', ''].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <td className="px-3 py-2.5" style={{ color: 'var(--text-primary)' }}>{u.nome}</td>
                  <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td className="px-3 py-2.5"><CopyId value={u.id} /></td>
                  <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{u.role}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <span style={{ color: u.ativo ? '#22c55e' : 'var(--text-muted)' }}>{u.ativo ? 'ativo' : 'inativo'}</span>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center justify-end gap-1">
                      <Button size="sm" variant="outline" className="h-7 text-xs" disabled={impersonate.isPending} onClick={() => impersonate.mutate(u.id)}>
                        <LogIn className="mr-1 h-3.5 w-3.5" /> Entrar como
                      </Button>
                      <Button
                        size="icon" variant="ghost" className="h-7 w-7"
                        title={u.ativo ? 'Banir' : 'Reativar'}
                        disabled={banUser.isPending}
                        onClick={() => banUser.mutate({ userId: u.id, banned: u.ativo })}
                      >
                        {u.ativo ? <Ban className="h-3.5 w-3.5 text-amber-500" /> : <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" />}
                      </Button>
                      {u.id !== ownerId && (
                        <Button
                          size="icon" variant="ghost" className="h-7 w-7"
                          title="Excluir usuário"
                          disabled={deleteUser.isPending}
                          onClick={() => { if (confirm(`Excluir ${u.email}? Ação irreversível.`)) deleteUser.mutate(u.id); }}
                        >
                          <Trash2 className="h-3.5 w-3.5 text-red-500" />
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Instâncias */}
      {data.instances.length > 0 && (
        <div>
          <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Instâncias WhatsApp</h4>
          <div className="flex flex-wrap gap-2">
            {data.instances.map((i) => (
              <span key={i.id} className="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs" style={{ borderColor: 'var(--border-default)' }}>
                <span className="h-2 w-2 rounded-full" style={{ background: liveStatus(i.status) ? '#22c55e' : '#6b7280' }} />
                {i.nome} <span className="text-muted-foreground">· {i.status}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <DeleteTenantDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        nome={data.nome}
        counts={{ users: data.counts.users, leads: data.counts.leads, instances: data.instances.length }}
        pending={deleteTenant.isPending}
        onConfirm={() => deleteTenant.mutate()}
      />
    </div>
  );
}

function BillingCard({
  tenantId, billing, onChanged,
}: {
  tenantId: string;
  billing: { billing_value: number | null; billing_cycle_months: number | null; billing_paid_until: string | null };
  onChanged: () => void;
}) {
  const [valor, setValor] = useState(billing.billing_value != null ? String(billing.billing_value / 100) : '');
  const [ciclo, setCiclo] = useState(String(billing.billing_cycle_months ?? 1));
  const [pagoAte, setPagoAte] = useState(billing.billing_paid_until ? billing.billing_paid_until.slice(0, 10) : '');

  const save = useMutation({
    mutationFn: async () =>
      api.patch(`/api/platform-admin/tenants/${tenantId}/billing`, {
        billing_value: valor.trim() ? Math.round(Number(valor.replace(',', '.')) * 100) : null,
        billing_cycle_months: valor.trim() ? Number(ciclo) : null,
        billing_paid_until: pagoAte ? new Date(`${pagoAte}T12:00:00Z`).toISOString() : null,
      }),
    onSuccess: () => { toast.success('Cobrança salva'); onChanged(); },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao salvar cobrança'),
  });

  const markPaid = useMutation({
    mutationFn: async () =>
      (await api.post<{ ok: boolean; paid_until: string }>(`/api/platform-admin/tenants/${tenantId}/billing/mark-paid`)).data,
    onSuccess: (res) => {
      toast.success(`Pago até ${new Date(res.paid_until).toLocaleDateString('pt-BR', { timeZone: 'UTC' })}`);
      onChanged();
    },
    onError: (e: unknown) => toast.error((e as { response?: { data?: { message?: string } } })?.response?.data?.message ?? 'Falha ao marcar pago'),
  });

  return (
    <div className="rounded-xl border p-4 space-y-3" style={{ borderColor: 'var(--border-default)', background: 'var(--bg-surface-2)' }}>
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Cobrança</h4>
        {billing.billing_value != null && (
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            {moneyFmt(billing.billing_value)} a cada {billing.billing_cycle_months ?? 1} mês(es)
          </span>
        )}
      </div>
      <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_auto_auto] sm:items-end">
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-muted)' }}>Valor (R$)</label>
          <Input value={valor} onChange={(e) => setValor(e.target.value)} placeholder="300,00" inputMode="decimal" className="h-9" />
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-muted)' }}>Ciclo</label>
          <Select value={ciclo} onValueChange={setCiclo}>
            <SelectTrigger className="h-9"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="1">Mensal</SelectItem>
              <SelectItem value="3">Trimestral</SelectItem>
              <SelectItem value="6">Semestral</SelectItem>
              <SelectItem value="12">Anual</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <label className="mb-1 block text-xs" style={{ color: 'var(--text-muted)' }}>Pago até</label>
          <Input type="date" value={pagoAte} onChange={(e) => setPagoAte(e.target.value)} className="h-9" />
        </div>
        <Button size="sm" className="h-9" disabled={save.isPending} onClick={() => save.mutate()}>
          Salvar cobrança
        </Button>
        <Button
          size="sm" variant="outline" className="h-9"
          disabled={markPaid.isPending || billing.billing_cycle_months == null}
          title={billing.billing_cycle_months == null ? 'Defina valor e ciclo antes' : undefined}
          onClick={() => markPaid.mutate()}
        >
          <BadgeCheck className="mr-1 h-3.5 w-3.5 text-emerald-500" /> Marcar pago (+ciclo)
        </Button>
      </div>
    </div>
  );
}
