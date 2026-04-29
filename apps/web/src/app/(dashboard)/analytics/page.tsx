'use client';

import { useMemo, useCallback, useEffect, useRef, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';
import type { LucideIcon } from 'lucide-react';
import {
  Users,
  TrendingUp,
  Target,
  DollarSign,
  Trophy,
  BarChart3,
  Clock,
  AlertCircle,
} from 'lucide-react';
import { format, subDays } from 'date-fns';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { KpiCard } from '@/components/dashboard/kpi-card';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

const numberFmt = new Intl.NumberFormat('pt-BR');
const brlFmt = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

function formatBRL(value: number): string {
  return brlFmt.format(value);
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
}

// ---------------------------------------------------------------------------
// Types matching backend response shapes
// ---------------------------------------------------------------------------

interface OverviewData {
  period: { from: string; to: string };
  total_leads: number;
  new_leads: number;
  won_leads: number;
  lost_leads: number;
  open_leads: number;
  total_value: number;
  won_value: number;
  avg_ticket: number;
  conversion_rate: number;
}

interface FunnelStageData {
  id: string;
  nome: string;
  cor: string;
  count: number;
  value: number;
  is_won: boolean;
  is_lost: boolean;
}

interface FunnelData {
  pipeline_id: string;
  stages: FunnelStageData[];
}

interface ConversionStageData {
  id: string;
  nome: string;
  entered: number;
  current: number;
  next_stage_count: number;
  conversion_rate: number;
}

interface ConversionData {
  pipeline_id: string;
  period: { from: string; to: string };
  stages: ConversionStageData[];
}

interface TimeInStageData {
  id: string;
  nome: string;
  avg_days: number;
  median_days: number;
  samples: number;
}

interface TimeInStageResponse {
  pipeline_id: string;
  stages: TimeInStageData[];
}

interface UserPerformanceData {
  id: string;
  nome: string;
  total_leads: number;
  new_leads: number;
  won_leads: number;
  lost_leads: number;
  won_value: number;
  conversion_rate: number;
  pending_tasks: number;
}

interface PerformanceData {
  period: { from: string; to: string };
  users: UserPerformanceData[];
}

interface Pipeline {
  id: string;
  nome: string;
  arquivado?: boolean;
}

// ---------------------------------------------------------------------------
// SectionCard — identical style to dashboard/page.tsx
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// FunnelSection — custom Tailwind bars
// ---------------------------------------------------------------------------

function FunnelSection({ data, isLoading }: { data: FunnelData | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <SectionCard title="Funil de Etapas" icon={BarChart3}>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const stages = data?.stages ?? [];
  const max = Math.max(1, ...stages.map((s) => s.count));
  const firstCount = stages[0]?.count ?? 1;

  if (stages.length === 0) {
    return (
      <SectionCard title="Funil de Etapas" icon={BarChart3}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem dados de funil para este pipeline.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Funil de Etapas" icon={BarChart3}>
      <div className="space-y-3">
        {stages.map((stage) => {
          const widthPct = Math.max((stage.count / max) * 100, 4);
          const ofFirst = firstCount > 0 ? Math.round((stage.count / firstCount) * 100) : 0;
          return (
            <div key={stage.id} className="flex items-center gap-3">
              <div
                className="w-28 text-xs font-medium truncate shrink-0"
                style={{ color: 'var(--text-secondary)' }}
                title={stage.nome}
              >
                {stage.nome}
              </div>
              <div
                className="flex-1 h-8 rounded-lg overflow-hidden relative"
                style={{ background: 'var(--bg-surface-3)' }}
              >
                <div
                  className="h-full rounded-lg transition-all duration-500 flex items-center px-3"
                  style={{ width: `${widthPct}%`, background: stage.cor || 'var(--primary)' }}
                >
                  <span className="text-xs font-semibold text-white whitespace-nowrap" style={{ fontFeatureSettings: '"tnum"' }}>
                    {numberFmt.format(stage.count)}
                  </span>
                </div>
              </div>
              <div
                className="w-10 text-xs text-right font-medium shrink-0"
                style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
              >
                {ofFirst}%
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// ConversionSection — horizontal bar chart
// ---------------------------------------------------------------------------

function ConversionSection({ data, isLoading }: { data: ConversionData | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <SectionCard title="Conversão por Etapa" icon={TrendingUp}>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const stages = data?.stages ?? [];
  const maxEntered = Math.max(1, ...stages.map((s) => s.entered));

  if (stages.length === 0) {
    return (
      <SectionCard title="Conversão por Etapa" icon={TrendingUp}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem dados de conversão para este pipeline e período.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Conversão por Etapa" icon={TrendingUp}>
      <div className="space-y-4">
        {stages.map((stage) => {
          const enteredPct = (stage.entered / maxEntered) * 100;
          const nextPct = stage.entered > 0 ? (stage.next_stage_count / stage.entered) * 100 : 0;
          const rate = (stage.conversion_rate * 100).toFixed(1);
          return (
            <div key={stage.id}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-xs font-medium truncate" style={{ color: 'var(--text-secondary)' }}>
                  {stage.nome}
                </span>
                <span className="text-xs shrink-0 ml-2" style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}>
                  {stage.entered} entraram · {stage.next_stage_count} avançaram · <strong>{rate}%</strong>
                </span>
              </div>
              <div className="relative h-5 rounded-lg overflow-hidden" style={{ background: 'var(--bg-surface-3)' }}>
                {/* entered bar */}
                <div
                  className="absolute inset-y-0 left-0 rounded-lg transition-all duration-500"
                  style={{ width: `${enteredPct}%`, background: 'var(--primary)', opacity: 0.25 }}
                />
                {/* next_stage bar */}
                <div
                  className="absolute inset-y-0 left-0 rounded-lg transition-all duration-500"
                  style={{ width: `${(nextPct / 100) * enteredPct}%`, background: 'var(--primary)' }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// TimeInStageSection — horizontal bars
// ---------------------------------------------------------------------------

function TimeInStageSection({ data, isLoading }: { data: TimeInStageResponse | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <SectionCard title="Tempo Médio por Etapa" icon={Clock}>
        <div className="space-y-3">
          {[0, 1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const stages = data?.stages ?? [];
  const maxDays = Math.max(1, ...stages.map((s) => s.avg_days));

  if (stages.length === 0) {
    return (
      <SectionCard title="Tempo Médio por Etapa" icon={Clock}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem dados de tempo por etapa.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Tempo Médio por Etapa" icon={Clock}>
      <div className="space-y-3">
        {stages.map((stage) => {
          const widthPct = Math.max((stage.avg_days / maxDays) * 100, 4);
          return (
            <div key={stage.id} className="flex items-center gap-3">
              <div
                className="w-28 text-xs font-medium truncate shrink-0"
                style={{ color: 'var(--text-secondary)' }}
                title={stage.nome}
              >
                {stage.nome}
              </div>
              <div
                className="flex-1 h-7 rounded-lg overflow-hidden relative"
                style={{ background: 'var(--bg-surface-3)' }}
              >
                <div
                  className="h-full rounded-lg transition-all duration-500 flex items-center px-3"
                  style={{ width: `${widthPct}%`, background: 'var(--primary)' }}
                >
                  <span className="text-xs font-semibold text-white whitespace-nowrap" style={{ fontFeatureSettings: '"tnum"' }}>
                    {stage.avg_days.toFixed(1)}d
                  </span>
                </div>
              </div>
              <div
                className="w-14 text-xs text-right shrink-0"
                style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
              >
                {stage.samples} amostras
              </div>
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// PerformanceTable
// ---------------------------------------------------------------------------

function PerformanceTable({ data, isLoading }: { data: PerformanceData | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <SectionCard title="Performance por Responsável" icon={Trophy} className="col-span-full">
        <div className="space-y-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const users = [...(data?.users ?? [])].sort((a, b) => b.won_value - a.won_value);

  if (users.length === 0) {
    return (
      <SectionCard title="Performance por Responsável" icon={Trophy} className="col-span-full">
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem dados de performance para o período selecionado.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Performance por Responsável" icon={Trophy} className="col-span-full">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border-default)' }}>
              {['Responsável', 'Total leads', 'Novos', 'Ganhos', 'Valor ganho', 'Conv. %', 'Tasks pendentes'].map((col) => (
                <th
                  key={col}
                  className="py-2 px-3 text-left text-xs font-semibold uppercase tracking-wide"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {col}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {users.map((user, idx) => (
              <tr
                key={user.id}
                style={{
                  borderBottom: idx < users.length - 1 ? '1px solid var(--border-default)' : undefined,
                }}
              >
                <td className="py-3 px-3">
                  <div className="flex items-center gap-2">
                    <div
                      className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold shrink-0"
                      style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
                    >
                      {initials(user.nome) || '?'}
                    </div>
                    <span className="font-medium" style={{ color: 'var(--text-primary)' }}>
                      {user.nome}
                    </span>
                  </div>
                </td>
                <td className="py-3 px-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {numberFmt.format(user.total_leads)}
                </td>
                <td className="py-3 px-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {numberFmt.format(user.new_leads)}
                </td>
                <td className="py-3 px-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {numberFmt.format(user.won_leads)}
                </td>
                <td className="py-3 px-3 tabular-nums font-medium" style={{ color: '#22c55e' }}>
                  {formatBRL(user.won_value)}
                </td>
                <td className="py-3 px-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {formatPct(user.conversion_rate)}
                </td>
                <td className="py-3 px-3 tabular-nums" style={{ color: 'var(--text-secondary)' }}>
                  {numberFmt.format(user.pending_tasks)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// Default date range helpers
// ---------------------------------------------------------------------------

function defaultFrom(): string {
  return format(subDays(new Date(), 30), 'yyyy-MM-dd');
}

function defaultTo(): string {
  return format(new Date(), 'yyyy-MM-dd');
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function AnalyticsPage() {
  return (
    <Suspense fallback={<div className="p-6"><Skeleton className="h-96 w-full" /></div>}>
      <AnalyticsPageInner />
    </Suspense>
  );
}

function AnalyticsPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();

  // Eventos podem chegar em rajada — debounce evita 5 refetches por mensagem.
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const socket = getSocket();
    const scheduleInvalidate = () => {
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = setTimeout(() => {
        queryClient.invalidateQueries({
          predicate: (q) => {
            const k = q.queryKey?.[0];
            return typeof k === 'string' && k.startsWith('analytics-');
          },
        });
      }, 2000);
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

  const from = searchParams.get('from') ?? defaultFrom();
  const to = searchParams.get('to') ?? defaultTo();
  const pipelineIdParam = searchParams.get('pipeline_id') ?? '';

  const setParam = useCallback(
    (key: string, value: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set(key, value);
      router.replace(`/analytics?${params.toString()}`);
    },
    [router, searchParams],
  );

  // Pipelines
  const { data: pipelines = [] } = useQuery<Pipeline[]>({
    queryKey: ['pipelines'],
    queryFn: async () => {
      const res = await api.get('/api/pipelines');
      return res.data as Pipeline[];
    },
  });

  const activePipelines = useMemo(
    () => pipelines.filter((p) => !p.arquivado),
    [pipelines],
  );

  // Resolve active pipeline id: URL param → first active pipeline
  const pipelineId = useMemo(() => {
    if (pipelineIdParam && activePipelines.some((p) => p.id === pipelineIdParam)) {
      return pipelineIdParam;
    }
    return activePipelines[0]?.id ?? '';
  }, [pipelineIdParam, activePipelines]);

  // Set pipeline in URL once resolved (on first load)
  const { data: overview, isLoading: overviewLoading, isError: overviewError } = useQuery<OverviewData>({
    queryKey: ['analytics-overview', from, to],
    queryFn: async () => {
      const res = await api.get('/api/analytics/overview', { params: { from, to } });
      return res.data as OverviewData;
    },
    enabled: true,
  });

  const { data: funnel, isLoading: funnelLoading } = useQuery<FunnelData>({
    queryKey: ['analytics-funnel', pipelineId],
    queryFn: async () => {
      const res = await api.get('/api/analytics/funnel', { params: { pipeline_id: pipelineId } });
      return res.data as FunnelData;
    },
    enabled: !!pipelineId,
  });

  const { data: conversion, isLoading: conversionLoading } = useQuery<ConversionData>({
    queryKey: ['analytics-conversion', pipelineId, from, to],
    queryFn: async () => {
      const res = await api.get('/api/analytics/conversion', {
        params: { pipeline_id: pipelineId, from, to },
      });
      return res.data as ConversionData;
    },
    enabled: !!pipelineId,
  });

  const { data: timeInStage, isLoading: timeLoading } = useQuery<TimeInStageResponse>({
    queryKey: ['analytics-time-in-stage', pipelineId],
    queryFn: async () => {
      const res = await api.get('/api/analytics/time-in-stage', {
        params: { pipeline_id: pipelineId },
      });
      return res.data as TimeInStageResponse;
    },
    enabled: !!pipelineId,
  });

  const { data: performance, isLoading: performanceLoading } = useQuery<PerformanceData>({
    queryKey: ['analytics-performance', from, to, pipelineId],
    queryFn: async () => {
      const params: Record<string, string> = { from, to };
      if (pipelineId) params.pipeline_id = pipelineId;
      const res = await api.get('/api/analytics/performance', { params });
      return res.data as PerformanceData;
    },
  });

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-end gap-4">
        <div className="flex-1">
          <h2
            className="text-2xl font-semibold tracking-tight"
            style={{ color: 'var(--text-primary)' }}
          >
            Analytics
          </h2>
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            Métricas de funil, conversão e performance da equipe
          </p>
        </div>

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Date from */}
          <div className="flex flex-col gap-0.5">
            <label
              htmlFor="analytics-from"
              className="text-[10px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              De
            </label>
            <input
              id="analytics-from"
              type="date"
              value={from}
              max={to}
              onChange={(e) => setParam('from', e.target.value)}
              className="h-9 rounded-lg border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)] transition-shadow"
              style={{
                borderColor: 'var(--border-default)',
                color: 'var(--text-primary)',
                colorScheme: 'dark',
              }}
            />
          </div>

          {/* Date to */}
          <div className="flex flex-col gap-0.5">
            <label
              htmlFor="analytics-to"
              className="text-[10px] font-medium uppercase tracking-wide"
              style={{ color: 'var(--text-muted)' }}
            >
              Até
            </label>
            <input
              id="analytics-to"
              type="date"
              value={to}
              min={from}
              max={format(new Date(), 'yyyy-MM-dd')}
              onChange={(e) => setParam('to', e.target.value)}
              className="h-9 rounded-lg border bg-transparent px-3 text-sm outline-none focus:ring-2 focus:ring-[var(--primary)] transition-shadow"
              style={{
                borderColor: 'var(--border-default)',
                color: 'var(--text-primary)',
                colorScheme: 'dark',
              }}
            />
          </div>

          {/* Pipeline selector */}
          {activePipelines.length > 0 && (
            <div className="flex flex-col gap-0.5">
              <label
                className="text-[10px] font-medium uppercase tracking-wide"
                style={{ color: 'var(--text-muted)' }}
              >
                Pipeline
              </label>
              <Select
                value={pipelineId}
                onValueChange={(v) => setParam('pipeline_id', v)}
              >
                <SelectTrigger className="h-9 w-44">
                  <SelectValue placeholder="Selecionar pipeline" />
                </SelectTrigger>
                <SelectContent>
                  {activePipelines.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {p.nome}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
      </div>

      {/* Error banner */}
      {overviewError && (
        <div
          className="rounded-lg border px-4 py-3 flex items-center gap-2 text-sm"
          style={{
            background: 'rgba(239,68,68,0.08)',
            borderColor: 'rgba(239,68,68,0.3)',
            color: '#ef4444',
          }}
        >
          <AlertCircle size={16} />
          Falha ao carregar overview. Os dados podem estar incompletos.
        </div>
      )}

      {/* KPI Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {overviewLoading ? (
          <>
            {[Users, TrendingUp, Trophy, Target, DollarSign, BarChart3].map((Icon, i) => (
              <KpiCard key={i} icon={Icon} label="" value="" loading />
            ))}
          </>
        ) : (
          <>
            <KpiCard
              icon={Users}
              label="Total de leads"
              value={numberFmt.format(overview?.total_leads ?? 0)}
            />
            <KpiCard
              icon={TrendingUp}
              label="Novos no período"
              value={numberFmt.format(overview?.new_leads ?? 0)}
            />
            <KpiCard
              icon={Trophy}
              label="Ganhos"
              value={numberFmt.format(overview?.won_leads ?? 0)}
              sub={formatBRL(overview?.won_value ?? 0)}
            />
            <KpiCard
              icon={Target}
              label="Perdidos"
              value={numberFmt.format(overview?.lost_leads ?? 0)}
            />
            <KpiCard
              icon={BarChart3}
              label="Taxa de conversão"
              value={formatPct(overview?.conversion_rate ?? 0)}
            />
            <KpiCard
              icon={DollarSign}
              label="Ticket médio"
              value={formatBRL(overview?.avg_ticket ?? 0)}
            />
          </>
        )}
      </div>

      {/* Funnel + Conversion row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FunnelSection data={funnel} isLoading={funnelLoading} />
        <ConversionSection data={conversion} isLoading={conversionLoading} />
      </div>

      {/* Time in stage */}
      <TimeInStageSection data={timeInStage} isLoading={timeLoading} />

      {/* Performance table */}
      <div className="grid grid-cols-1 gap-4">
        <PerformanceTable data={performance} isLoading={performanceLoading} />
      </div>
    </div>
  );
}
