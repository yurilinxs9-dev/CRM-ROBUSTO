'use client';

import { Flame, Snowflake, Thermometer, ThermometerSun } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

export interface TempDatum {
  temperatura: string;
  count: number;
}

const TEMP_CONFIG: Record<string, { label: string; color: string; icon: LucideIcon }> = {
  FRIO: { label: 'Frio', color: '#3b82f6', icon: Snowflake },
  MORNO: { label: 'Morno', color: '#eab308', icon: Thermometer },
  QUENTE: { label: 'Quente', color: '#f97316', icon: ThermometerSun },
  FOGO: { label: 'Fogo', color: '#ef4444', icon: Flame },
  MUITO_QUENTE: { label: 'Muito Quente', color: '#ef4444', icon: Flame },
};

export function TemperatureDonut({ data }: { data: TempDatum[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);

  if (total === 0) {
    return (
      <div className="flex items-center justify-center h-48" style={{ color: 'var(--text-muted)' }}>
        <p className="text-sm">Sem dados</p>
      </div>
    );
  }

  const radius = 68;
  const circumference = 2 * Math.PI * radius;
  let cumulative = 0;

  const segments = data.map((d) => {
    const pct = d.count / total;
    const dashLength = pct * circumference;
    const offset = cumulative;
    cumulative += dashLength;
    const cfg = TEMP_CONFIG[d.temperatura] ?? {
      label: d.temperatura,
      color: 'var(--text-muted)',
      icon: Thermometer,
    };
    return { ...d, pct, dashLength, offset, ...cfg };
  });

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
          <span
            className="text-3xl font-bold"
            style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
          >
            {total}
          </span>
          <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
            total
          </span>
        </div>
      </div>
      <div className="w-full grid grid-cols-2 gap-2">
        {segments.map((seg) => {
          const SegIcon = seg.icon;
          return (
            <div key={seg.temperatura} className="flex items-center gap-2 text-xs">
              <span
                className="w-6 h-6 rounded-md flex items-center justify-center flex-shrink-0"
                style={{ background: `${seg.color}1a`, color: seg.color }}
              >
                <SegIcon size={12} />
              </span>
              <span style={{ color: 'var(--text-secondary)' }}>{seg.label}</span>
              <span
                className="ml-auto font-semibold"
                style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
              >
                {seg.count}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
