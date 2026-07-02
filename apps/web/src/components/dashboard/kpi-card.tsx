'use client';

import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp } from 'lucide-react';

interface KpiCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  trend?: number | null;
  /** Métricas onde subir é RUIM (ex.: leads perdidos) — inverte a cor do delta. */
  invertTrend?: boolean;
  loading?: boolean;
}

export function KpiCard({ icon: Icon, label, value, sub, trend, invertTrend, loading }: KpiCardProps) {
  if (loading) {
    return (
      <div
        className="rounded-xl border p-5 h-[130px] animate-pulse"
        style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
      />
    );
  }

  const hasTrend = typeof trend === 'number' && Number.isFinite(trend);
  const positive = (trend ?? 0) >= 0;
  // Ícone segue a DIREÇÃO real; cor segue se a direção é boa ou ruim.
  const good = invertTrend ? (trend ?? 0) <= 0 : positive;
  const TrendIcon = positive ? TrendingUp : TrendingDown;

  return (
    <div
      className="rounded-xl border p-4 sm:p-5 transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-start justify-between gap-2 mb-3">
        <p className="text-[11px] sm:text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <div
          className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg flex items-center justify-center shrink-0"
          style={{ background: 'var(--primary-subtle)' }}
        >
          <Icon size={16} style={{ color: 'var(--primary)' }} />
        </div>
      </div>
      <p
        className="text-2xl sm:text-3xl font-bold tracking-tight"
        style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
      >
        {value}
      </p>
      {(sub || hasTrend) && (
        <div className="flex items-center gap-1.5 mt-2">
          {hasTrend && (
            <span
              className="inline-flex items-center gap-0.5 text-xs font-medium"
              // --destructive é triplet HSL (shadcn), não cor CSS — usar hex direto.
              style={{ color: good ? 'var(--success, #22c55e)' : '#ef4444' }}
            >
              <TrendIcon size={12} />
              {positive ? '+' : ''}
              {trend}%
            </span>
          )}
          {sub && (
            <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
              {sub}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
