import type { LucideIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';

interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Ação primária opcional — todo empty state útil oferece o próximo passo. */
  actionLabel?: string;
  onAction?: () => void;
  className?: string;
}

/**
 * Empty state padrão do app (Onda 2 da auditoria UI): ícone em disco sutil,
 * título curto, descrição de 1 linha e ação. Substitui os <p> soltos.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-line-2 px-6 py-12 text-center',
        className,
      )}
    >
      <div className="flex h-11 w-11 items-center justify-center rounded-full bg-brand-subtle">
        <Icon size={20} className="text-primary" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium text-ink-1">{title}</p>
        {description && <p className="max-w-sm text-xs text-ink-3">{description}</p>}
      </div>
      {actionLabel && onAction && (
        <Button size="sm" variant="outline" onClick={onAction} className="mt-1">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
