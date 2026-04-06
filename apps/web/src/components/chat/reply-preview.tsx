'use client';

import { X, Reply } from 'lucide-react';
import { Button } from '@/components/ui/button';

export interface ReplyTarget {
  id: string;
  author: string;
  preview: string;
}

interface ReplyPreviewProps {
  target: ReplyTarget;
  onCancel: () => void;
}

export function ReplyPreview({ target, onCancel }: ReplyPreviewProps) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-muted/40 px-3 py-2">
      <div className="flex h-8 w-1 flex-shrink-0 rounded-full bg-primary" />
      <div className="min-w-0 flex-1">
        <p className="flex items-center gap-1 text-[11px] font-semibold text-primary">
          <Reply size={11} />
          Respondendo a {target.author}
        </p>
        <p className="truncate text-xs text-muted-foreground">{target.preview}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="h-7 w-7 flex-shrink-0"
        aria-label="Cancelar resposta"
        onClick={onCancel}
      >
        <X size={14} />
      </Button>
    </div>
  );
}
