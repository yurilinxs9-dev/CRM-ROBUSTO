'use client';

import { useState } from 'react';

export interface TrendPoint {
  date: string; // yyyy-MM-dd
  count: number;
}

const numberFmt = new Intl.NumberFormat('pt-BR');

function ddmm(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${d}/${m}`;
}

/**
 * Gráfico de área responsivo em SVG puro (sem dependência de lib de charts).
 * Escala via viewBox + width:100%. Hover mostra tooltip com data + valor.
 */
export function AreaChart({ data, height = 180 }: { data: TrendPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);

  if (!data || data.length === 0) {
    return (
      <div className="text-sm text-center py-12" style={{ color: 'var(--text-muted)' }}>
        Sem dados no período.
      </div>
    );
  }

  const W = 600;
  const H = height;
  const padX = 6;
  const padTop = 14;
  const padBottom = 22;
  const max = Math.max(1, ...data.map((d) => d.count));
  const n = data.length;

  const x = (i: number) => padX + (n === 1 ? 0.5 : i / (n - 1)) * (W - padX * 2);
  const y = (v: number) => padTop + (1 - v / max) * (H - padTop - padBottom);

  const linePoints = data.map((d, i) => `${x(i)},${y(d.count)}`).join(' ');
  const areaPath =
    `M ${x(0)},${H - padBottom} ` +
    data.map((d, i) => `L ${x(i)},${y(d.count)}`).join(' ') +
    ` L ${x(n - 1)},${H - padBottom} Z`;

  const total = data.reduce((a, b) => a + b.count, 0);
  const labelIdx = [0, Math.floor((n - 1) / 2), n - 1];

  return (
    <div className="w-full">
      <div className="flex items-baseline gap-2 mb-3">
        <span
          className="text-2xl font-bold tracking-tight"
          style={{ color: 'var(--text-primary)', fontFeatureSettings: '"tnum"' }}
        >
          {numberFmt.format(total)}
        </span>
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          leads em {n} dias
        </span>
      </div>

      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          width="100%"
          height={H}
          preserveAspectRatio="none"
          onMouseLeave={() => setHover(null)}
          style={{ display: 'block', overflow: 'visible' }}
        >
          <defs>
            <linearGradient id="areaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
            </linearGradient>
          </defs>

          {/* baseline */}
          <line
            x1={padX}
            y1={H - padBottom}
            x2={W - padX}
            y2={H - padBottom}
            stroke="var(--border-default)"
            strokeWidth="1"
          />

          <path d={areaPath} fill="url(#areaGrad)" />
          <polyline
            points={linePoints}
            fill="none"
            stroke="var(--primary)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* hover marker */}
          {hover !== null && (
            <>
              <line
                x1={x(hover)}
                y1={padTop}
                x2={x(hover)}
                y2={H - padBottom}
                stroke="var(--primary)"
                strokeWidth="1"
                strokeDasharray="3 3"
                opacity="0.5"
                vectorEffect="non-scaling-stroke"
              />
              <circle cx={x(hover)} cy={y(data[hover].count)} r="4" fill="var(--primary)" stroke="white" strokeWidth="1.5" />
            </>
          )}

          {/* invisible hover zones */}
          {data.map((d, i) => (
            <rect
              key={i}
              x={i === 0 ? 0 : (x(i) + x(i - 1)) / 2}
              y={0}
              width={i === 0 ? x(0) + (x(1) - x(0)) / 2 : ((x(Math.min(i + 1, n - 1)) - x(i - 1)) / 2)}
              height={H}
              fill="transparent"
              onMouseEnter={() => setHover(i)}
            />
          ))}

          {/* x labels */}
          {labelIdx.map((i) => (
            <text
              key={i}
              x={x(i)}
              y={H - 6}
              textAnchor={i === 0 ? 'start' : i === n - 1 ? 'end' : 'middle'}
              fontSize="11"
              fill="var(--text-muted)"
            >
              {ddmm(data[i].date)}
            </text>
          ))}
        </svg>

        {/* tooltip */}
        {hover !== null && (
          <div
            className="absolute -top-1 px-2 py-1 rounded-md text-xs pointer-events-none whitespace-nowrap shadow-lg"
            style={{
              left: `${(x(hover) / W) * 100}%`,
              transform: 'translate(-50%, -100%)',
              background: 'var(--bg-surface-3)',
              border: '1px solid var(--border-default)',
              color: 'var(--text-primary)',
            }}
          >
            <strong>{numberFmt.format(data[hover].count)}</strong> · {ddmm(data[hover].date)}
          </div>
        )}
      </div>
    </div>
  );
}
