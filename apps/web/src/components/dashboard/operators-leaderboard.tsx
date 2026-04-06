'use client';

export interface OperatorRow {
  id: string;
  nome: string;
  leadsCount: number;
  messagesSent: number;
  avgResponse: number;
}

const numberFmt = new Intl.NumberFormat('pt-BR');

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((s) => s[0]?.toUpperCase() ?? '')
    .join('');
}

export function OperatorsLeaderboard({ operators }: { operators: OperatorRow[] }) {
  if (operators.length === 0) {
    return (
      <p className="text-sm text-center py-10" style={{ color: 'var(--text-muted)' }}>
        Sem dados de operadores.
      </p>
    );
  }

  const top = operators.slice(0, 5);
  const maxLeads = Math.max(1, ...top.map((o) => o.leadsCount));

  return (
    <ul className="space-y-3">
      {top.map((op, idx) => {
        const pct = (op.leadsCount / maxLeads) * 100;
        return (
          <li key={op.id} className="flex items-center gap-3">
            <span
              className="w-6 text-xs font-bold text-center flex-shrink-0"
              style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
            >
              #{idx + 1}
            </span>
            <div
              className="w-9 h-9 rounded-full flex items-center justify-center flex-shrink-0 text-xs font-semibold"
              style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
            >
              {initials(op.nome) || '?'}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2 mb-1">
                <p
                  className="text-sm font-medium truncate"
                  style={{ color: 'var(--text-primary)' }}
                >
                  {op.nome}
                </p>
                <p
                  className="text-xs flex-shrink-0"
                  style={{ color: 'var(--text-muted)', fontFeatureSettings: '"tnum"' }}
                >
                  {numberFmt.format(op.leadsCount)} leads ·{' '}
                  {numberFmt.format(op.messagesSent)} msgs
                </p>
              </div>
              <div
                className="h-1.5 rounded-full overflow-hidden"
                style={{ background: 'var(--bg-surface-3)' }}
              >
                <div
                  className="h-full rounded-full transition-all duration-500"
                  style={{ width: `${pct}%`, background: 'var(--primary)' }}
                />
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
