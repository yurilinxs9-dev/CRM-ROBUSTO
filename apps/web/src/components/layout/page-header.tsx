'use client';

import type { ReactNode } from 'react';

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Ações à direita (botões, filtros). */
  actions?: ReactNode;
  /** Mostra um badge "ao vivo" pulsante. */
  live?: boolean;
}

/**
 * Cabeçalho padrão de página — título + subtítulo + ações.
 * Unifica o markup que cada página repetia de forma diferente.
 */
export function PageHeader({ title, subtitle, actions, live }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <h2
            className="text-xl sm:text-2xl font-semibold tracking-tight truncate"
            style={{ color: 'var(--text-primary)' }}
          >
            {title}
          </h2>
          {live && (
            <span
              className="inline-flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-full shrink-0"
              style={{ background: 'var(--primary-subtle)', color: 'var(--primary)' }}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-current animate-pulse" />
              Ao vivo
            </span>
          )}
        </div>
        {subtitle && (
          <p className="text-sm mt-0.5" style={{ color: 'var(--text-muted)' }}>
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2 shrink-0">{actions}</div>}
    </div>
  );
}
