'use client';

import { ArrowDown } from 'lucide-react';
import { cn } from '@/lib/cn';

interface ScrollToBottomButtonProps {
  visible: boolean;
  unread?: number;
  onClick: () => void;
}

export function ScrollToBottomButton({
  visible,
  unread = 0,
  onClick,
}: ScrollToBottomButtonProps) {
  if (!visible) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Ir para o fim"
      className={cn(
        'absolute bottom-4 right-4 z-20 flex h-10 items-center gap-2 rounded-full border border-border bg-card px-3 text-xs font-medium text-foreground shadow-lg transition-all',
        'hover:bg-accent',
      )}
    >
      <ArrowDown size={14} />
      {unread > 0 ? `${unread} nova${unread > 1 ? 's' : ''}` : 'Novas mensagens'}
    </button>
  );
}
