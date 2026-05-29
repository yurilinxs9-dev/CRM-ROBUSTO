'use client';

import { useParams, useRouter } from 'next/navigation';
import { useQuery, useMutation } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ArrowLeft, LogIn, Smartphone, Users, Contact, MessageSquare } from 'lucide-react';
import { api } from '@/lib/api';
import { useAuthStore } from '@/stores/auth.store';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';

interface TenantUser {
  id: string; nome: string; email: string; role: string; ativo: boolean; is_platform_admin: boolean;
}
interface TenantInstance { id: string; nome: string; status: string; telefone?: string | null }
interface TenantDetail {
  id: string; nome: string; pool_enabled: boolean; prefix_enabled: boolean; created_at: string;
  owner: { id: string; nome: string; email: string } | null;
  users: TenantUser[];
  instances: TenantInstance[];
  counts: { leads: number; messages: number; users: number };
}

const numberFmt = new Intl.NumberFormat('pt-BR');
const liveStatus = (s: string) => ['open', 'connected', 'connecting'].includes(s);

export default function AdminTenantDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;
  const startImpersonation = useAuthStore((s) => s.startImpersonation);

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

  if (isLoading || !data) {
    return <div className="space-y-3"><Skeleton className="h-8 w-48" /><Skeleton className="h-40 w-full rounded-xl" /></div>;
  }

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

      <div>
        <h3 className="text-lg font-semibold" style={{ color: 'var(--text-primary)' }}>{data.nome}</h3>
        <p className="text-sm" style={{ color: 'var(--text-muted)' }}>
          Owner: {data.owner?.nome} ({data.owner?.email}) · {data.pool_enabled ? 'Compartilhado' : 'Individual'}
        </p>
      </div>

      <div className="flex flex-wrap gap-2">
        {stat(Users, 'usuários', data.counts.users)}
        {stat(Contact, 'leads', data.counts.leads)}
        {stat(MessageSquare, 'mensagens', data.counts.messages)}
        {stat(Smartphone, 'instâncias', data.instances.length)}
      </div>

      {/* Equipe */}
      <div>
        <h4 className="text-sm font-semibold mb-2" style={{ color: 'var(--text-primary)' }}>Equipe</h4>
        <div className="rounded-xl border overflow-hidden" style={{ borderColor: 'var(--border-default)' }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: 'var(--bg-surface-2)', borderBottom: '1px solid var(--border-default)' }}>
                {['Nome', 'Email', 'Papel', 'Status', ''].map((h) => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id} style={{ borderBottom: '1px solid var(--border-default)' }}>
                  <td className="px-3 py-2.5" style={{ color: 'var(--text-primary)' }}>{u.nome}</td>
                  <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{u.email}</td>
                  <td className="px-3 py-2.5 text-xs" style={{ color: 'var(--text-secondary)' }}>{u.role}</td>
                  <td className="px-3 py-2.5 text-xs">
                    <span style={{ color: u.ativo ? '#22c55e' : 'var(--text-muted)' }}>{u.ativo ? 'ativo' : 'inativo'}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <Button size="sm" variant="outline" className="h-7 text-xs" disabled={impersonate.isPending} onClick={() => impersonate.mutate(u.id)}>
                      <LogIn className="mr-1 h-3.5 w-3.5" /> Entrar como
                    </Button>
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
    </div>
  );
}
