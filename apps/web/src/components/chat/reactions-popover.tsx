'use client';

import { Smile } from 'lucide-react';
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover';

export const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏'] as const;

interface ReactionsPopoverProps {
  onSelect: (emoji: string) => void;
}

export function ReactionsPopover({ onSelect }: ReactionsPopoverProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label="Adicionar reação"
          className="flex h-6 w-6 items-center justify-center rounded-full bg-card/90 text-muted-foreground shadow-sm transition hover:bg-card hover:text-foreground"
        >
          <Smile size={12} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" side="top" className="w-auto p-1">
        <div className="flex gap-0.5">
          {REACTION_EMOJIS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              onClick={() => onSelect(emoji)}
              className="flex h-8 w-8 items-center justify-center rounded-md text-lg transition hover:bg-muted"
              aria-label={`Reagir com ${emoji}`}
            >
              {emoji}
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
