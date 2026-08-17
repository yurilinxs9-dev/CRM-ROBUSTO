'use client';

import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';
import { Skeleton } from '@/components/ui/skeleton';
import { channelMeta, percentFmt, type AttributionSummary } from '@/lib/attribution';

/**
 * Donut de origem dos leads. Busca os próprios dados de propósito: assim entrar
 * no dashboard custa uma linha, sem mexer no fetch que já existe na página.
 *
 * Mesma linguagem visual de temperature-donut.tsx.
 */
export function AttributionDonut({ from, to }: { from?: string; to?: string }) {
  const { data, isLoading } = useQuery<AttributionSummary>({
    queryKey: ['attribution-summary', from ?? null, to ?? null],
    queryFn: async () => {
      const params: Record<string, string> = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await api.get('/api/attribution/summary', { params });
      return res.data;
    },
    staleTime: 60_000,
  });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center gap-4">
        <Skeleton className="h-[170px] w-[170px] rounded-full" />
        <Skeleton className="h-4 w-32" />
      </div>
    );
  }

  const channels = (data?.channels ?? []).filter((c) => c.leads > 0);
  const total = channels.reduce((s, c) => s + c.leads, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">Sem dados no período</p>
      </div>
    );
  }

  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  const segments = channels.map((c) => {
    const pct = c.leads / total;
    const dashLength = pct * circumference;
    const offset = cumulative;
    cumulative += dashLength;
    return { ...c, pct, dashLength, offset, ...channelMeta(String(c.channel)) };
  });

  const paidShare = data?.paid.share ?? 0;

  return (
    <div className="flex flex-col items-center gap-5">
      <div className="relative">
        <svg width="170" height="170" viewBox="0 0 180 180">
          <circle
            cx="90"
            cy="90"
            r={radius}
            fill="none"
            stroke="var(--bg-surface-3)"
            strokeWidth="20"
          />
          {segments.map((seg) => (
            <circle
              key={String(seg.channel)}
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
          <span
            className="text-3xl font-bold"
            style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
          >
            {percentFmt(paidShare)}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            tráfego pago
          </span>
        </div>
      </div>
      <div className="w-full grid grid-cols-1 sm:grid-cols-2 gap-2">
        {segments.map((seg) => (
          <div key={String(seg.channel)} className="flex items-center gap-2 text-xs">
            <span
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ background: seg.color }}
            />
            <span className="truncate" style={{ color: 'var(--text-secondary)' }}>
              {seg.label}
            </span>
            <span
              className="ml-auto font-semibold"
              style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
            >
              {seg.leads}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
