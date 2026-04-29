'use client';

import Link from 'next/link';
import { useEffect, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';
import type { LucideIcon } from 'lucide-react';
import {
  Users,
  TrendingUp,
  Target,
  Clock,
  Trophy,
  Activity,
  BarChart3,
  ThermometerSun,
  AlertCircle,
  Plus,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { FunnelChart, type FunnelStage } from '@/components/dashboard/funnel-chart';
import { TemperatureDonut, type TempDatum } from '@/components/dashboard/temperature-donut';
import { ActivityFeed, type ActivityItem } from '@/components/dashboard/activity-feed';
import {
  OperatorsLeaderboard,
  type OperatorRow,
} from '@/components/dashboard/operators-leaderboard';

interface DashboardStats {
  leadsByStage: FunnelStage[];
  totalLeads: number;
  leadsThisWeek: number;
  leadsLastWeek: number;
  conversionRate: number;
  avgResponseMinutes: number;
  leadsByTemp: TempDatum[];
  recentActivity: ActivityItem[];
  topOperators: OperatorRow[];
}

const numberFmt = new Intl.NumberFormat('pt-BR');
const percentFmt = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  maximumFractionDigits: 1,
});

function formatMinutes(mins: number): string {
  if (!Number.isFinite(mins) || mins <= 0) return '—';
  const h = Math.floor(mins / 60);
  const m = Math.round(mins % 60);
  if (h === 0) return `${m}min`;
  if (m === 0) return `${h}h`;
  return `${h}h ${m}min`;
}

function weeklyTrend(thisWeek: number, lastWeek: number): number | null {
  if (lastWeek <= 0) return thisWeek > 0 ? 100 : null;
  return Math.round(((thisWeek - lastWeek) / lastWeek) * 100);
}

function SectionCard({
  title,
  icon: Icon,
  children,
  className = '',
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)] ${className}`}
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center gap-2 mb-5">
        <Icon size={16} style={{ color: 'var(--text-muted)' }} />
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
      </div>
      {children}
    </div>
  );
}

function DashboardHeader() {
  return (
    <div>
      <h2
        className="text-2xl font-semibold tracking-tight"
        style={{ color: 'var(--text-primary)' }}
      >
        Dashboard
      </h2>
      <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
        Visão geral do funil de vendas
      </p>
    </div>
  );
}

export default function DashboardPage() {
  const queryClient = useQueryClient();

  const { data: stats, isLoading, isError } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const { data } = await api.get('/api/dashboard/stats');
      return data as DashboardStats;
    },
    refetchInterval: 30_000,
  });

  // Eventos podem chegar em rajada (msgs em massa, drag-drop kanban). Debounce
  // evita refetch por evento e mantém o dashboard responsivo sem floodar a API.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const scheduleInvalidate = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['dashboard-stats'] });
      }, 1500);
    };
    socket.on('lead:new-message', scheduleInvalidate);
    socket.on('lead:stage-changed', scheduleInvalidate);
    socket.on('lead:updated', scheduleInvalidate);
    return () => {
      socket.off('lead:new-message', scheduleInvalidate);
      socket.off('lead:stage-changed', scheduleInvalidate);
      socket.off('lead:updated', scheduleInvalidate);
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
    };
  }, [queryClient]);

  const trend = stats ? weeklyTrend(stats.leadsThisWeek, stats.leadsLastWeek) : null;

  if (!isLoading && stats && stats.totalLeads === 0) {
    return (
      <div className="p-6 space-y-6">
        <DashboardHeader />
        <div
          className="rounded-xl border p-12 flex flex-col items-center justify-center text-center"
          style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
        >
          <div
            className="w-14 h-14 rounded-2xl flex items-center justify-center mb-4"
            style={{ background: 'var(--primary-subtle)' }}
          >
            <Users size={24} style={{ color: 'var(--primary)' }} />
          </div>
          <h3 className="text-lg font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
            Nenhum lead ainda
          </h3>
          <p className="text-sm mb-5" style={{ color: 'var(--text-muted)' }}>
            Crie seu primeiro lead para começar a acompanhar o funil.
          </p>
          <Link
            href="/kanban"
            className="inline-flex items-center gap-2 h-10 px-5 rounded-lg text-sm font-medium transition-opacity hover:opacity-90"
            style={{ background: 'var(--primary)', color: 'white' }}
          >
            <Plus size={15} />
            Criar primeiro lead
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <DashboardHeader />

      {isError && (
        <div
          className="rounded-lg border px-4 py-3 flex items-center gap-2 text-sm"
          style={{
            background: 'rgba(239,68,68,0.08)',
            borderColor: 'rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          <AlertCircle size={16} />
          Falha ao carregar estatísticas. Tentaremos novamente automaticamente.
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {isLoading ? (
          <>
            <KpiCard icon={Users} label="" value="" loading />
            <KpiCard icon={TrendingUp} label="" value="" loading />
            <KpiCard icon={Target} label="" value="" loading />
            <KpiCard icon={Clock} label="" value="" loading />
          </>
        ) : (
          <>
            <KpiCard
              icon={Users}
              label="Total de Leads"
              value={numberFmt.format(stats?.totalLeads ?? 0)}
              trend={trend}
              sub="vs. semana passada"
            />
            <KpiCard
              icon={TrendingUp}
              label="Leads esta semana"
              value={numberFmt.format(stats?.leadsThisWeek ?? 0)}
              sub={`Semana passada: ${numberFmt.format(stats?.leadsLastWeek ?? 0)}`}
            />
            <KpiCard
              icon={Target}
              label="Taxa de conversão"
              value={percentFmt.format((stats?.conversionRate ?? 0) / 100)}
              sub="Meta: 15%"
            />
            <KpiCard
              icon={Clock}
              label="Tempo médio resposta"
              value={formatMinutes(stats?.avgResponseMinutes ?? 0)}
              sub="SLA: 30min"
            />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Funil de Vendas" icon={BarChart3} className="lg:col-span-2">
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-8 w-full" />
              ))}
            </div>
          ) : (
            <FunnelChart stages={stats?.leadsByStage ?? []} />
          )}
        </SectionCard>

        <SectionCard title="Distribuição por Temperatura" icon={ThermometerSun}>
          {isLoading ? (
            <div className="flex flex-col items-center gap-4">
              <Skeleton className="h-[170px] w-[170px] rounded-full" />
              <Skeleton className="h-4 w-32" />
            </div>
          ) : (
            <TemperatureDonut data={stats?.leadsByTemp ?? []} />
          )}
        </SectionCard>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <SectionCard title="Atividade Recente" icon={Activity}>
          {isLoading ? (
            <div className="space-y-3">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <ActivityFeed items={stats?.recentActivity ?? []} />
          )}
        </SectionCard>

        <SectionCard title="Top Operadores" icon={Trophy}>
          {isLoading ? (
            <div className="space-y-4">
              {[0, 1, 2, 3, 4].map((i) => (
                <Skeleton key={i} className="h-12 w-full" />
              ))}
            </div>
          ) : (
            <OperatorsLeaderboard operators={stats?.topOperators ?? []} />
          )}
        </SectionCard>
      </div>
    </div>
  );
}
