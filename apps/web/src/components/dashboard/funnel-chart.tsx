'use client';

export interface FunnelStage {
  stageId: string;
  nome: string;
  cor: string;
  count: number;
}

const numberFmt = new Intl.NumberFormat('pt-BR');

export function FunnelChart({ stages }: { stages: FunnelStage[] }) {
  const total = stages.reduce((s, st) => s + st.count, 0);
  const max = Math.max(1, ...stages.map((s) => s.count));

  if (stages.length === 0) {
    return (
      <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
        Sem dados de funil.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {stages.map((stage) => {
        const widthPct = Math.max((stage.count / max) * 100, 4);
        const totalPct = total > 0 ? Math.round((stage.count / total) * 100) : 0;
        return (
          <div key={stage.stageId} className="flex items-center gap-3">
            <div
              className="w-32 text-xs font-medium truncate"
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
                style={{ width: `${widthPct}%`, background: stage.cor }}
              >
                <span
                  className="text-xs font-semibold text-white whitespace-nowrap"
                  style={{ fontFeatureSettings: '"tnum"' }}
                >
                  {numberFmt.format(stage.count)}
                </span>
              </div>
            </div>
            <div
              className="w-12 text-xs text-right font-medium"
              style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
            >
              {totalPct}%
            </div>
          </div>
        );
      })}
    </div>
  );
}
