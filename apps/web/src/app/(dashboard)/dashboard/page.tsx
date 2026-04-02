'use client';

import { useEffect, useRef, useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Users,
  TrendingUp,
  Clock,
  Target,
  Download,
  Activity,
  UserPlus,
  MessageCircle,
  Phone,
  Edit3,
  ArrowRight,
  Trophy,
  BarChart3,
} from 'lucide-react';
import { toast } from 'sonner';
import { api } from '@/lib/api';

// --- Types ---

interface StageCount {
  stageId: string;
  nome: string;
  cor: string;
  count: number;
}

interface TempCount {
  temperatura: string;
  count: number;
}

interface RecentActivity {
  id: string;
  leadNome: string;
  action: string;
  operatorNome: string;
  createdAt: string;
}

interface TopOperator {
  id: string;
  nome: string;
  leadsCount: number;
  messagesSent: number;
  avgResponse: number;
}

interface DashboardStats {
  totalLeads: number;
  leadsThisWeek: number;
  leadsLastWeek: number;
  avgResponseMinutes: number;
  conversionRate: number;
  leadsByStage: StageCount[];
  leadsByTemp: TempCount[];
  recentActivity: RecentActivity[];
  topOperators: TopOperator[];
}

// --- Animated Number Hook ---

function useAnimatedNumber(target: number, duration = 800): number {
  const [value, setValue] = useState(0);
  const animRef = useRef<number | null>(null);

  useEffect(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);

    const start = performance.now();
    const from = 0;

    const tick = (now: number) => {
      const elapsed = now - start;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      setValue(Math.round(from + (target - from) * eased));
      if (progress < 1) {
        animRef.current = requestAnimationFrame(tick);
      }
    };

    animRef.current = requestAnimationFrame(tick);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
    };
  }, [target, duration]);

  return value;
}

// --- Temperature config ---

const tempConfig: Record<string, { label: string; color: string }> = {
  FRIO:         { label: 'Frio',         color: 'var(--temp-frio)' },
  MORNO:        { label: 'Morno',        color: 'var(--temp-morno)' },
  QUENTE:       { label: 'Quente',       color: 'var(--temp-quente)' },
  MUITO_QUENTE: { label: 'Muito Quente', color: 'var(--temp-muito-quente)' },
};

// --- Activity action config ---

const actionConfig: Record<string, { label: string; icon: typeof Activity }> = {
  lead_created:    { label: 'Novo lead',        icon: UserPlus },
  message_sent:    { label: 'Mensagem enviada',  icon: MessageCircle },
  message_received:{ label: 'Mensagem recebida', icon: MessageCircle },
  call_made:       { label: 'Ligação',           icon: Phone },
  stage_changed:   { label: 'Etapa alterada',    icon: ArrowRight },
  note_added:      { label: 'Nota adicionada',   icon: Edit3 },
};

function timeAgo(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return 'agora';
  if (minutes < 60) return `${minutes}min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// --- Donut Chart Component ---

function DonutChart({ data }: { data: TempCount[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">Sem dados</p>
      </div>
    );
  }

  const radius = 70;
  const circumference = 2 * Math.PI * radius;
  let cumulativeOffset = 0;

  const segments = data.map((d) => {
    const pct = d.count / total;
    const dashLength = pct * circumference;
    const offset = cumulativeOffset;
    cumulativeOffset += dashLength;
    const config = tempConfig[d.temperatura];
    return { ...d, pct, dashLength, offset, color: config?.color ?? 'var(--text-muted)', label: config?.label ?? d.temperatura };
  });

  return (
    <div className="flex items-center gap-6">
      <div className="relative flex-shrink-0">
        <svg width="160" height="160" viewBox="0 0 180 180">
          {segments.map((seg) => (
            <circle
              key={seg.temperatura}
              cx="90"
              cy="90"
              r={radius}
              fill="none"
              stroke={seg.color}
              strokeWidth="20"
              strokeDasharray={`${seg.dashLength} ${circumference - seg.dashLength}`}
              strokeDashoffset={-seg.offset}
              transform="rotate(-90 90 90)"
              style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold" style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}>
            {total}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>total</span>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {segments.map((seg) => (
          <div key={seg.temperatura} className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full flex-shrink-0" style={{ background: seg.color }} />
            <span className="text-xs" style={{ color: 'var(--text-secondary)' }}>{seg.label}</span>
            <span className="text-xs font-medium ml-auto" style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}>
              {seg.count} ({Math.round(seg.pct * 100)}%)
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

// --- Main Component ---

export default function DashboardPage() {
  const { data: stats, isLoading } = useQuery<DashboardStats>({
    queryKey: ['dashboard-stats'],
    queryFn: async () => {
      const { data } = await api.get('/api/dashboard/stats');
      return data as DashboardStats;
    },
    refetchInterval: 60_000,
  });

  const totalLeads = useAnimatedNumber(stats?.totalLeads ?? 0);
  const leadsThisWeek = useAnimatedNumber(stats?.leadsThisWeek ?? 0);
  const avgResponse = useAnimatedNumber(stats?.avgResponseMinutes ?? 0);
  const conversionRate = useAnimatedNumber(stats?.conversionRate ?? 0);

  const weeklyChange = stats && stats.leadsLastWeek > 0
    ? Math.round(((stats.leadsThisWeek - stats.leadsLastWeek) / stats.leadsLastWeek) * 100)
    : 0;

  const maxStageCount = Math.max(1, ...(stats?.leadsByStage?.map((s) => s.count) ?? [1]));

  // --- CSV Export ---
  const exportCSV = useCallback(async () => {
    try {
      const { data } = await api.get('/api/dashboard/stats');
      const d = data as DashboardStats;

      const rows: string[] = [
        'Etapa,Cor,Quantidade',
        ...(d.leadsByStage?.map((s) => `${s.nome},${s.cor},${s.count}`) ?? []),
        '',
        'Temperatura,Quantidade',
        ...(d.leadsByTemp?.map((t) => `${t.temperatura},${t.count}`) ?? []),
        '',
        'Operador,Leads,Mensagens,Tempo Resp. (min)',
        ...(d.topOperators?.map((o) => `${o.nome},${o.leadsCount},${o.messagesSent},${o.avgResponse}`) ?? []),
      ];

      const blob = new Blob([rows.join('\n')], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `dashboard-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('CSV exportado com sucesso');
    } catch {
      toast.error('Erro ao exportar CSV');
    }
  }, []);

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center py-20" style={{ color: 'var(--text-muted)' }}>
        <div className="animate-spin w-6 h-6 border-2 border-current rounded-full" style={{ borderTopColor: 'transparent' }} />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold" style={{ color: 'var(--text-primary)' }}>Dashboard</h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>Visão geral do CRM</p>
        </div>
        <button
          onClick={exportCSV}
          className="flex items-center gap-2 h-9 px-4 rounded-lg text-sm font-medium transition-opacity hover:opacity-80"
          style={{ background: 'var(--bg-surface-3)', color: 'var(--text-secondary)', border: '1px solid var(--border-default)' }}
        >
          <Download size={15} />
          Exportar CSV
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard icon={Users} label="Total Leads" value={totalLeads} />
        <KPICard
          icon={TrendingUp}
          label="Leads esta semana"
          value={leadsThisWeek}
          badge={weeklyChange !== 0 ? `${weeklyChange > 0 ? '+' : ''}${weeklyChange}%` : undefined}
          badgePositive={weeklyChange >= 0}
        />
        <KPICard icon={Clock} label="Tempo médio resposta" value={avgResponse} suffix="min" />
        <KPICard icon={Target} label="Taxa de conversão" value={conversionRate} suffix="%" />
      </div>

      {/* Pipeline Funnel */}
      <div
        className="rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)]"
        style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2 mb-5">
          <BarChart3 size={16} style={{ color: 'var(--text-muted)' }} />
          <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Funil de Conversão
          </h3>
        </div>
        <div className="space-y-3">
          {stats?.leadsByStage?.map((stage) => {
            const pct = Math.round((stage.count / maxStageCount) * 100);
            const totalLeadsCount = stats.leadsByStage.reduce((s, st) => s + st.count, 0);
            const stagePct = totalLeadsCount > 0 ? Math.round((stage.count / totalLeadsCount) * 100) : 0;
            return (
              <div key={stage.stageId} className="flex items-center gap-3">
                <div className="w-28 text-xs truncate" style={{ color: 'var(--text-secondary)' }}>
                  {stage.nome}
                </div>
                <div className="flex-1 h-7 rounded-lg overflow-hidden relative" style={{ background: 'var(--bg-surface-3)' }}>
                  <div
                    className="h-full rounded-lg transition-all duration-500 flex items-center px-2.5"
                    style={{ width: `${Math.max(pct, 8)}%`, background: stage.cor }}
                  >
                    <span className="text-xs font-medium text-white whitespace-nowrap" style={{ fontFeatureSettings: '"tnum"' }}>
                      {stage.count}
                    </span>
                  </div>
                </div>
                <div className="w-12 text-xs text-right" style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}>
                  {stagePct}%
                </div>
              </div>
            );
          })}
          {(!stats?.leadsByStage || stats.leadsByStage.length === 0) && (
            <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
              Sem dados disponíveis.
            </p>
          )}
        </div>
      </div>

      {/* Two Columns: Temperature Donut + Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Left: Leads por Temperatura */}
        <div
          className="rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)]"
          style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
        >
          <h3 className="font-semibold text-sm mb-5" style={{ color: 'var(--text-primary)' }}>
            Leads por Temperatura
          </h3>
          <DonutChart data={stats?.leadsByTemp ?? []} />
        </div>

        {/* Right: Atividade Recente */}
        <div
          className="rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)]"
          style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
        >
          <h3 className="font-semibold text-sm mb-4" style={{ color: 'var(--text-primary)' }}>
            Atividade Recente
          </h3>
          <div className="space-y-1">
            {stats?.recentActivity?.slice(0, 10).map((act) => {
              const config = actionConfig[act.action] ?? { label: act.action, icon: Activity };
              const Icon = config.icon;
              return (
                <div
                  key={act.id}
                  className="flex items-center gap-3 py-2 px-2 rounded-lg transition-colors hover:bg-[var(--bg-surface-3)]"
                >
                  <div
                    className="w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0"
                    style={{ background: 'var(--bg-surface-3)' }}
                  >
                    <Icon size={13} style={{ color: 'var(--text-muted)' }} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs truncate" style={{ color: 'var(--text-primary)' }}>
                      <span className="font-medium">{act.leadNome}</span>
                      <span style={{ color: 'var(--text-muted)' }}> — {config.label}</span>
                    </p>
                    <p className="text-xs mt-0.5" style={{ color: 'var(--text-muted)' }}>
                      {act.operatorNome}
                    </p>
                  </div>
                  <span className="text-xs flex-shrink-0" style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}>
                    {timeAgo(act.createdAt)}
                  </span>
                </div>
              );
            })}
            {(!stats?.recentActivity || stats.recentActivity.length === 0) && (
              <p className="text-sm text-center py-6" style={{ color: 'var(--text-muted)' }}>
                Sem atividades recentes.
              </p>
            )}
          </div>
        </div>
      </div>

      {/* Top Operadores */}
      <div
        className="rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)]"
        style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
      >
        <div className="flex items-center gap-2 mb-5">
          <Trophy size={16} style={{ color: 'var(--text-muted)' }} />
          <h3 className="font-semibold text-sm" style={{ color: 'var(--text-primary)' }}>
            Top Operadores
          </h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <th className="text-left py-2 px-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>#</th>
                <th className="text-left py-2 px-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Operador</th>
                <th className="text-right py-2 px-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Leads</th>
                <th className="text-right py-2 px-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Mensagens</th>
                <th className="text-right py-2 px-3 text-xs font-medium" style={{ color: 'var(--text-muted)' }}>Tempo resp.</th>
              </tr>
            </thead>
            <tbody>
              {stats?.topOperators?.map((op, idx) => (
                <tr
                  key={op.id}
                  className="transition-colors hover:bg-[var(--bg-surface-3)]"
                  style={{ borderBottom: '1px solid var(--border-subtle)' }}
                >
                  <td className="py-2.5 px-3" style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}>
                    {idx + 1}
                  </td>
                  <td className="py-2.5 px-3 font-medium" style={{ color: 'var(--text-primary)' }}>
                    {op.nome}
                  </td>
                  <td className="py-2.5 px-3 text-right" style={{ color: 'var(--text-secondary)', fontFeatureSettings: '"tnum"' }}>
                    {op.leadsCount}
                  </td>
                  <td className="py-2.5 px-3 text-right" style={{ color: 'var(--text-secondary)', fontFeatureSettings: '"tnum"' }}>
                    {op.messagesSent}
                  </td>
                  <td className="py-2.5 px-3 text-right" style={{ color: 'var(--text-secondary)', fontFeatureSettings: '"tnum"' }}>
                    {op.avgResponse}min
                  </td>
                </tr>
              ))}
              {(!stats?.topOperators || stats.topOperators.length === 0) && (
                <tr>
                  <td colSpan={5} className="py-6 text-center text-sm" style={{ color: 'var(--text-muted)' }}>
                    Sem dados de operadores.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

// --- KPI Card Component ---

function KPICard({
  icon: Icon,
  label,
  value,
  suffix,
  badge,
  badgePositive,
}: {
  icon: typeof Users;
  label: string;
  value: number;
  suffix?: string;
  badge?: string;
  badgePositive?: boolean;
}) {
  return (
    <div
      className="rounded-xl p-4 border transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-center justify-between mb-3">
        <div
          className="w-8 h-8 rounded-lg flex items-center justify-center"
          style={{ background: 'var(--primary-subtle)' }}
        >
          <Icon size={15} style={{ color: 'var(--primary)' }} />
        </div>
        {badge && (
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{
              background: badgePositive ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)',
              color: badgePositive ? '#22c55e' : '#ef4444',
            }}
          >
            {badge}
          </span>
        )}
      </div>
      <p className="text-xs mb-0.5" style={{ color: 'var(--text-muted)' }}>{label}</p>
      <p
        className="text-2xl font-bold"
        style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
      >
        {value}{suffix && <span className="text-sm font-medium ml-0.5" style={{ color: 'var(--text-muted)' }}>{suffix}</span>}
      </p>
    </div>
  );
}
