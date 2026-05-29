'use client';

import { useQuery } from '@tanstack/react-query';
import { Building2, Users, Contact, MessageSquare, Smartphone, Wifi } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';

interface Stats {
  tenants: number;
  users: number;
  leads: number;
  messages: number;
  instances: number;
  active_instances: number;
}

const numberFmt = new Intl.NumberFormat('pt-BR');

function StatCard({ icon: Icon, label, value }: { icon: LucideIcon; label: string; value: string }) {
  return (
    <div
      className="rounded-xl border p-4 sm:p-5"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <span className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </span>
        <div className="flex h-9 w-9 items-center justify-center rounded-lg" style={{ background: 'var(--primary-subtle)' }}>
          <Icon size={16} style={{ color: 'var(--primary)' }} />
        </div>
      </div>
      <p className="text-2xl sm:text-3xl font-bold tracking-tight" style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}>
        {value}
      </p>
    </div>
  );
}

export default function AdminOverviewPage() {
  const { data, isLoading } = useQuery<Stats>({
    queryKey: ['admin-stats'],
    queryFn: async () => (await api.get<Stats>('/api/platform-admin/stats')).data,
    refetchInterval: 30_000,
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
        {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
      <StatCard icon={Building2} label="Clientes (tenants)" value={numberFmt.format(data?.tenants ?? 0)} />
      <StatCard icon={Users} label="Usuários" value={numberFmt.format(data?.users ?? 0)} />
      <StatCard icon={Contact} label="Leads" value={numberFmt.format(data?.leads ?? 0)} />
      <StatCard icon={MessageSquare} label="Mensagens" value={numberFmt.format(data?.messages ?? 0)} />
      <StatCard icon={Smartphone} label="Instâncias" value={numberFmt.format(data?.instances ?? 0)} />
      <StatCard icon={Wifi} label="Instâncias ativas" value={numberFmt.format(data?.active_instances ?? 0)} />
    </div>
  );
}
