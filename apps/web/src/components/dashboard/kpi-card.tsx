'use client';

import type { LucideIcon } from 'lucide-react';
import { TrendingDown, TrendingUp } from 'lucide-react';

interface KpiCardProps {
  icon: LucideIcon;
  label: string;
  value: string;
  sub?: string;
  trend?: number | null;
  loading?: boolean;
}

export function KpiCard({ icon: Icon, label, value, sub, trend, loading }: KpiCardProps) {
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
  const TrendIcon = positive ? TrendingUp : TrendingDown;

  return (
    <div
      className="rounded-xl border p-5 transition-colors hover:border-[var(--border-strong)]"
      style={{ background: 'var(--bg-surface-2)', borderColor: 'var(--border-default)' }}
    >
      <div className="flex items-start justify-between mb-3">
        <p className="text-xs font-medium uppercase tracking-wide" style={{ color: 'var(--text-muted)' }}>
          {label}
        </p>
        <div
          className="w-9 h-9 rounded-lg flex items-center justify-center"
          style={{ background: 'var(--primary-subtle)' }}
        >
          <Icon size={16} style={{ color: 'var(--primary)' }} />
        </div>
      </div>
      <p
        className="text-3xl font-bold tracking-tight"
        style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
      >
        {value}
      </p>
      {(sub || hasTrend) && (
        <div className="flex items-center gap-1.5 mt-2">
          {hasTrend && (
            <span
              className="inline-flex items-center gap-0.5 text-xs font-medium"
              style={{ color: positive ? 'var(--success, #22c55e)' : 'var(--destructive, #ef4444)' }}
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
