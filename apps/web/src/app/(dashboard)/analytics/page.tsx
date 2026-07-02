'use client';

import { useMemo, useCallback, useEffect, useRef, useState, Suspense } from 'react';
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
import { PageHeader } from '@/components/layout/page-header';
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

/** Delta % vs período anterior; null quando não há base de comparação. */
function trendPct(cur: number | undefined, prev: number | undefined): number | null {
  if (cur === undefined || prev === undefined || prev === 0) return null;
  return Math.round(((cur - prev) / prev) * 100);
}

/** Teto "bonito" pro eixo Y (1/2/5 × 10^n). */
function niceCeil(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const f = v / pow;
  const n = f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10;
  return n * pow;
}

/** Duração humana: 45s · 12min · 3h 20min · 2d 5h. */
function formatDuration(secs: number): string {
  if (secs < 60) return `${Math.max(secs, 0)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}min`;
  if (secs < 86400) {
    const h = Math.floor(secs / 3600);
    const m = Math.round((secs % 3600) / 60);
    return m > 0 ? `${h}h ${m}min` : `${h}h`;
  }
  const d = Math.floor(secs / 86400);
  const h = Math.round((secs % 86400) / 3600);
  return h > 0 ? `${d}d ${h}h` : `${d}d`;
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

interface OverviewWindow {
  new_leads: number;
  won_leads: number;
  lost_leads: number;
  won_value: number;
  avg_ticket: number;
  conversion_rate: number;
}

interface OverviewData extends OverviewWindow {
  period: { from: string; to: string };
  total_leads: number;
  open_leads: number;
  total_value: number;
  previous: OverviewWindow;
}

interface TimeseriesDay {
  day: string;
  new_leads: number;
  won_leads: number;
}

interface TimeseriesData {
  period: { from: string; to: string };
  days: TimeseriesDay[];
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

interface FirstResponseUser {
  id: string;
  nome: string;
  answered: number;
  median_seconds: number;
  avg_seconds: number;
}

interface FirstResponseData {
  period: { from: string; to: string };
  total_conversations: number;
  unanswered: number;
  users: FirstResponseUser[];
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
// DailyEvolutionSection — barras (novos/dia) + linha (ganhos/dia)
// Par de cores validado p/ daltonismo sobre #151d27 (ΔE deutan 95.6):
// azul #3b82f6 (novos) × verde #00a859 (ganhos); marcas distintas (barra vs
// linha) reforçam a identidade além da cor.
// ---------------------------------------------------------------------------

const SERIES_NOVOS = '#3b82f6';
const SERIES_GANHOS = '#00a859';

function DailyEvolutionSection({
  data,
  isLoading,
}: {
  data: TimeseriesData | undefined;
  isLoading: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);

  if (isLoading) {
    return (
      <SectionCard title="Evolução Diária" icon={TrendingUp}>
        <Skeleton className="h-56 w-full" />
      </SectionCard>
    );
  }

  const days = data?.days ?? [];
  const hasData = days.some((d) => d.new_leads > 0 || d.won_leads > 0);

  if (days.length === 0 || !hasData) {
    return (
      <SectionCard title="Evolução Diária" icon={TrendingUp}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem leads novos ou ganhos no período selecionado.
        </p>
      </SectionCard>
    );
  }

  const yMax = niceCeil(Math.max(...days.map((d) => Math.max(d.new_leads, d.won_leads))));
  const n = days.length;
  // Rótulos do eixo X: ~8 ticks, sempre incluindo o primeiro dia.
  const tickEvery = Math.max(1, Math.ceil(n / 8));
  const linePoints = days
    .map((d, i) => `${((i + 0.5) / n) * 100},${100 - (d.won_leads / yMax) * 100}`)
    .join(' ');
  const hovered = hover !== null ? days[hover] : null;

  const fmtDay = (day: string, long = false) =>
    format(new Date(`${day}T12:00:00`), long ? 'dd/MM/yyyy' : 'dd/MM');

  return (
    <SectionCard title="Evolução Diária" icon={TrendingUp}>
      {/* Legenda */}
      <div className="flex items-center gap-4 mb-4">
        {[
          { label: 'Novos leads', color: SERIES_NOVOS },
          { label: 'Ganhos', color: SERIES_GANHOS },
        ].map((s) => (
          <span key={s.label} className="inline-flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="flex gap-2">
        {/* Eixo Y */}
        <div
          className="flex flex-col justify-between text-right shrink-0 w-8 text-[10px] py-0"
          style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"', height: 208 }}
        >
          <span>{numberFmt.format(yMax)}</span>
          <span>{numberFmt.format(yMax / 2)}</span>
          <span>0</span>
        </div>

        {/* Área do gráfico */}
        <div className="relative flex-1" style={{ height: 208 }} onMouseLeave={() => setHover(null)}>
          {/* Gridlines recessivas */}
          {[0, 50, 100].map((pct) => (
            <div
              key={pct}
              className="absolute left-0 right-0 border-t"
              style={{ top: `${pct}%`, borderColor: 'var(--border-default)', opacity: pct === 100 ? 1 : 0.45 }}
            />
          ))}

          {/* Barras (novos) */}
          <div className="absolute inset-0 flex items-end">
            {days.map((d, i) => (
              <div
                key={d.day}
                className="flex-1 flex items-end justify-center h-full"
                onMouseEnter={() => setHover(i)}
              >
                {d.new_leads > 0 && (
                  <div
                    className="w-[60%] max-w-[28px] rounded-t transition-opacity"
                    style={{
                      height: `${Math.max((d.new_leads / yMax) * 100, 1.5)}%`,
                      background: SERIES_NOVOS,
                      opacity: hover === null || hover === i ? 1 : 0.45,
                    }}
                  />
                )}
              </div>
            ))}
          </div>

          {/* Linha (ganhos) */}
          <svg
            className="absolute inset-0 w-full h-full pointer-events-none"
            viewBox="0 0 100 100"
            preserveAspectRatio="none"
          >
            <polyline
              points={linePoints}
              fill="none"
              stroke={SERIES_GANHOS}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>

          {/* Crosshair do dia em hover */}
          {hover !== null && (
            <div
              className="absolute inset-y-0 pointer-events-none border-l border-dashed"
              style={{ left: `${((hover + 0.5) / n) * 100}%`, borderColor: 'var(--text-muted)', opacity: 0.5 }}
            />
          )}

          {/* Tooltip */}
          {hovered && hover !== null && (
            <div
              className="absolute z-10 rounded-lg border px-3 py-2 text-xs pointer-events-none shadow-lg"
              style={{
                background: 'var(--bg-surface-3)',
                borderColor: 'var(--border-default)',
                top: 4,
                left: `${((hover + 0.5) / n) * 100}%`,
                transform: `translateX(${hover < n / 4 ? '8px' : hover > (3 * n) / 4 ? 'calc(-100% - 8px)' : '-50%'})`,
              }}
            >
              <div className="font-semibold mb-1" style={{ color: 'var(--text-primary)' }}>
                {fmtDay(hovered.day, true)}
              </div>
              <div className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: SERIES_NOVOS }} />
                Novos: <strong style={{ fontFeatureSettings: '"tnum"' }}>{numberFmt.format(hovered.new_leads)}</strong>
              </div>
              <div className="flex items-center gap-1.5" style={{ color: 'var(--text-secondary)' }}>
                <span className="w-2 h-2 rounded-sm shrink-0" style={{ background: SERIES_GANHOS }} />
                Ganhos: <strong style={{ fontFeatureSettings: '"tnum"' }}>{numberFmt.format(hovered.won_leads)}</strong>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Eixo X */}
      <div className="flex ml-10 mt-1">
        {days.map((d, i) => (
          <div
            key={d.day}
            className="flex-1 text-center text-[10px] truncate"
            style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
          >
            {i % tickEvery === 0 ? fmtDay(d.day) : ''}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ---------------------------------------------------------------------------
// FunnelSection — custom Tailwind bars
// ---------------------------------------------------------------------------

function FunnelSection({ data, isLoading }: { data: FunnelData | undefined; isLoading: boolean }) {
  if (isLoading) {
    return (
      <SectionCard title="Funil de Etapas (atual)" icon={BarChart3}>
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
      <SectionCard title="Funil de Etapas (atual)" icon={BarChart3}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem dados de funil para este pipeline.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Funil de Etapas (atual)" icon={BarChart3}>
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
      <SectionCard title="Tempo Médio por Etapa (atual)" icon={Clock}>
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
      <SectionCard title="Tempo Médio por Etapa (atual)" icon={Clock}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Sem dados de tempo por etapa.
        </p>
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Tempo Médio por Etapa (atual)" icon={Clock}>
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
// FirstResponseSection — tempo de 1ª resposta por atendente
// Barra = mediana (menos sensível a outliers que a média; a média aparece ao
// lado). Ordenado do mais rápido pro mais lento.
// ---------------------------------------------------------------------------

function FirstResponseSection({
  data,
  isLoading,
}: {
  data: FirstResponseData | undefined;
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <SectionCard title="Tempo de 1ª Resposta por Atendente" icon={Clock}>
        <div className="space-y-3">
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} className="h-10 w-full" />
          ))}
        </div>
      </SectionCard>
    );
  }

  const users = data?.users ?? [];

  if (users.length === 0) {
    return (
      <SectionCard title="Tempo de 1ª Resposta por Atendente" icon={Clock}>
        <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
          Nenhuma conversa iniciada e respondida no período.
        </p>
      </SectionCard>
    );
  }

  const maxMedian = Math.max(1, ...users.map((u) => u.median_seconds));

  return (
    <SectionCard title="Tempo de 1ª Resposta por Atendente" icon={Clock}>
      <div className="space-y-3">
        {users.map((u) => {
          const widthPct = Math.max((u.median_seconds / maxMedian) * 100, 4);
          return (
            <div key={u.id} className="flex items-center gap-3">
              <div className="flex items-center gap-2 w-40 shrink-0 min-w-0">
                <div
                  className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0"
                  style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
                >
                  {initials(u.nome) || '?'}
                </div>
                <span
                  className="text-xs font-medium truncate"
                  style={{ color: 'var(--text-secondary)' }}
                  title={u.nome}
                >
                  {u.nome}
                </span>
              </div>
              <div
                className="flex-1 h-7 rounded-lg overflow-hidden relative"
                style={{ background: 'var(--bg-surface-3)' }}
              >
                <div
                  className="h-full rounded-lg transition-all duration-500 flex items-center px-3"
                  style={{ width: `${widthPct}%`, background: 'var(--primary)' }}
                >
                  <span
                    className="text-xs font-semibold text-white whitespace-nowrap"
                    style={{ fontFeatureSettings: '"tnum"' }}
                  >
                    {formatDuration(u.median_seconds)}
                  </span>
                </div>
              </div>
              <div
                className="w-36 text-xs text-right shrink-0"
                style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
              >
                média {formatDuration(u.avg_seconds)} · {numberFmt.format(u.answered)} conv.
              </div>
            </div>
          );
        })}
      </div>
      <p className="text-xs mt-4" style={{ color: 'var(--text-muted)' }}>
        Mediana da 1ª resposta humana por conversa iniciada no período ·{' '}
        {numberFmt.format(data?.total_conversations ?? 0)} conversas novas ·{' '}
        {numberFmt.format(data?.unanswered ?? 0)} sem resposta
      </p>
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

  // Atalho: define from+to numa só navegação (evita corrida entre 2 replaces).
  const setRange = useCallback(
    (days: number) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set('from', format(subDays(new Date(), days), 'yyyy-MM-dd'));
      params.set('to', format(new Date(), 'yyyy-MM-dd'));
      router.replace(`/analytics?${params.toString()}`);
    },
    [router, searchParams],
  );

  const activePreset = useMemo(() => {
    const today = format(new Date(), 'yyyy-MM-dd');
    if (to !== today) return null;
    for (const d of [7, 30, 90]) {
      if (from === format(subDays(new Date(), d), 'yyyy-MM-dd')) return d;
    }
    return null;
  }, [from, to]);

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

  const { data: timeseries, isLoading: timeseriesLoading } = useQuery<TimeseriesData>({
    queryKey: ['analytics-timeseries', from, to],
    queryFn: async () => {
      const res = await api.get('/api/analytics/timeseries', { params: { from, to } });
      return res.data as TimeseriesData;
    },
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

  const { data: firstResponse, isLoading: firstResponseLoading } = useQuery<FirstResponseData>({
    queryKey: ['analytics-first-response', from, to],
    queryFn: async () => {
      const res = await api.get('/api/analytics/first-response', { params: { from, to } });
      return res.data as FirstResponseData;
    },
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
    <div className="p-4 sm:p-6 space-y-6">
      {/* Header */}
      <PageHeader
        title="Analytics"
        subtitle="Métricas de funil, conversão e performance da equipe"
        actions={
          <div className="flex flex-wrap items-center gap-2">
          {/* Quick presets */}
          <div className="flex flex-col gap-0.5">
            <span className="text-[10px] font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
              Período
            </span>
            <div className="flex rounded-lg border overflow-hidden" style={{ borderColor: 'var(--border-default)' }}>
              {[
                { d: 7, label: '7d' },
                { d: 30, label: '30d' },
                { d: 90, label: '90d' },
              ].map((p) => {
                const active = activePreset === p.d;
                return (
                  <button
                    key={p.d}
                    type="button"
                    onClick={() => setRange(p.d)}
                    className="h-9 px-3 text-sm font-medium transition-colors"
                    style={{
                      background: active ? 'var(--primary)' : 'transparent',
                      color: active ? 'white' : 'var(--text-secondary)',
                    }}
                  >
                    {p.label}
                  </button>
                );
              })}
            </div>
          </div>

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
        }
      />

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
              sub={`${numberFmt.format(overview?.open_leads ?? 0)} em aberto`}
            />
            <KpiCard
              icon={TrendingUp}
              label="Novos no período"
              value={numberFmt.format(overview?.new_leads ?? 0)}
              trend={trendPct(overview?.new_leads, overview?.previous?.new_leads)}
            />
            <KpiCard
              icon={Trophy}
              label="Ganhos no período"
              value={numberFmt.format(overview?.won_leads ?? 0)}
              sub={formatBRL(overview?.won_value ?? 0)}
              trend={trendPct(overview?.won_leads, overview?.previous?.won_leads)}
            />
            <KpiCard
              icon={Target}
              label="Perdidos no período"
              value={numberFmt.format(overview?.lost_leads ?? 0)}
              trend={trendPct(overview?.lost_leads, overview?.previous?.lost_leads)}
              invertTrend
            />
            <KpiCard
              icon={BarChart3}
              label="Taxa de conversão"
              value={formatPct(overview?.conversion_rate ?? 0)}
              trend={trendPct(overview?.conversion_rate, overview?.previous?.conversion_rate)}
            />
            <KpiCard
              icon={DollarSign}
              label="Ticket médio"
              value={formatBRL(overview?.avg_ticket ?? 0)}
              trend={trendPct(overview?.avg_ticket, overview?.previous?.avg_ticket)}
            />
          </>
        )}
      </div>

      {/* Evolução diária */}
      <DailyEvolutionSection data={timeseries} isLoading={timeseriesLoading} />

      {/* Funnel + Conversion row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <FunnelSection data={funnel} isLoading={funnelLoading} />
        <ConversionSection data={conversion} isLoading={conversionLoading} />
      </div>

      {/* First response por atendente */}
      <FirstResponseSection data={firstResponse} isLoading={firstResponseLoading} />

      {/* Time in stage */}
      <TimeInStageSection data={timeInStage} isLoading={timeLoading} />

      {/* Performance table */}
      <div className="grid grid-cols-1 gap-4">
        <PerformanceTable data={performance} isLoading={performanceLoading} />
      </div>
    </div>
  );
}
