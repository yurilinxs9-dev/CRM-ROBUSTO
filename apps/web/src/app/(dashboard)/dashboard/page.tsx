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
  LineChart,
  MessageSquare,
  CheckSquare,
  DollarSign,
} from 'lucide-react';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiCard } from '@/components/dashboard/kpi-card';
import { AreaChart, type TrendPoint } from '@/components/dashboard/area-chart';
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
  wonValue: number;
  openConversations: number;
  pendingTasks: number;
  leadsTrend: TrendPoint[];
  leadsByTemp: TempDatum[];
  recentActivity: ActivityItem[];
  topOperators: OperatorRow[];
}

const numberFmt = new Intl.NumberFormat('pt-BR');
const percentFmt = new Intl.NumberFormat('pt-BR', {
  style: 'percent',
  maximumFractionDigits: 1,
});
const brlFmt = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
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
  action,
}: {
  title: string;
  icon: LucideIcon;
  children: React.ReactNode;
  className?: string;
  action?: React.ReactNode;
}) {
  return (
    <div
      className={`rounded-xl border p-4 sm:p-5 transition-colors hover:border-[var(--border-strong)] ${className}`}
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center gap-2 mb-5">
        <Icon size={16} style={{ color: 'var(--text-muted)' }} />
        <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
          {title}
        </h3>
        {action && <div className="ml-auto">{action}</div>}
      </div>
      {children}
    </div>
  );
}

function MiniStat({
  icon: Icon,
  label,
  value,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warn';
}) {
  const color =
    tone === 'success' ? '#22c55e' : tone === 'warn' ? '#f59e0b' : 'var(--text-primary)';
  return (
    <div
      className="rounded-xl border p-4 flex items-center gap-3"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div
        className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
        style={{ background: 'var(--primary-subtle)' }}
      >
        <Icon size={18} style={{ color: 'var(--primary)' }} />
      </div>
      <div className="min-w-0">
        <p className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <p
          className="text-xl font-bold tracking-tight truncate"
          style={{ color, fontFeatureSettings: '"tnum"' }}
        >
          {value}
        </p>
      </div>
    </div>
  );
}

function DashboardHeader() {
  return (
    <div className="flex items-start justify-between gap-3">
      <div>
        <h2
          className="text-xl sm:text-2xl font-semibold tracking-tight"
          style={{ color: 'var(--text-primary)' }}
        >
          Dashboard
        </h2>
        <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
          Visão geral do funil em tempo real
        </p>
      </div>
      <span
        className="hidden sm:inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full shrink-0"
        style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
      >
        <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
        Ao vivo
      </span>
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
      <div className="p-4 sm:p-6 space-y-6">
        <DashboardHeader />
        <div
          className="rounded-xl border p-8 sm:p-12 flex flex-col items-center justify-center text-center"
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
    <div className="p-4 sm:p-6 space-y-5 sm:space-y-6">
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

      {/* KPIs primários */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
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
              sub={`Anterior: ${numberFmt.format(stats?.leadsLastWeek ?? 0)}`}
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

      {/* Tendência + stats secundários */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SectionCard title="Leads (últimos 14 dias)" icon={LineChart} className="lg:col-span-2">
          {isLoading ? (
            <Skeleton className="h-[180px] w-full" />
          ) : (
            <AreaChart data={stats?.leadsTrend ?? []} />
          )}
        </SectionCard>

        <div className="grid grid-cols-1 sm:grid-cols-3 lg:grid-cols-1 gap-3 sm:gap-4">
          {isLoading ? (
            <>
              <Skeleton className="h-[72px] w-full rounded-xl" />
              <Skeleton className="h-[72px] w-full rounded-xl" />
              <Skeleton className="h-[72px] w-full rounded-xl" />
            </>
          ) : (
            <>
              <MiniStat
                icon={MessageSquare}
                label="Conversas não lidas"
                value={numberFmt.format(stats?.openConversations ?? 0)}
                tone={stats && stats.openConversations > 0 ? 'warn' : 'default'}
              />
              <MiniStat
                icon={CheckSquare}
                label="Tarefas pendentes"
                value={numberFmt.format(stats?.pendingTasks ?? 0)}
              />
              <MiniStat
                icon={DollarSign}
                label="Valor ganho"
                value={brlFmt.format(stats?.wonValue ?? 0)}
                tone="success"
              />
            </>
          )}
        </div>
      </div>

      {/* Funil + Temperatura */}
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

      {/* Atividade + Operadores */}
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
