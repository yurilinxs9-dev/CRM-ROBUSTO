'use client';

/**
 * Campo de busca do topbar — desde a palette (Ctrl+K), é só um gatilho:
 * a busca de verdade vive em layout/command-palette.tsx. Mantém a cara
 * de input para não mudar o layout do header.
 *
 * `hidden md:flex` vem do wrapper antigo: no mobile o topbar não tem espaço
 * para o campo, e o Ctrl+K continua valendo para quem tem teclado.
 */

import { Search } from 'lucide-react';

export function HeaderSearch(): JSX.Element {
  return (
    <button
      type="button"
      aria-label="Buscar contato"
      aria-keyshortcuts="Control+K"
      onClick={() => window.dispatchEvent(new CustomEvent('abrir-palette'))}
      className="hidden h-9 w-64 items-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground md:flex"
    >
      <Search className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">Buscar contato...</span>
      <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] font-medium">Ctrl K</kbd>
    </button>
  );
}
