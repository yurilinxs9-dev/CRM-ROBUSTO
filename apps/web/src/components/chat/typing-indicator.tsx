'use client';

import { memo } from 'react';

function TypingIndicatorComponent() {
  return (
    <div className="my-1 flex justify-start">
      <div className="flex items-center gap-1 rounded-2xl rounded-bl-sm border border-border bg-card px-3 py-2 shadow-sm">
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: '0ms' }}
        />
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: '150ms' }}
        />
        <span
          className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted-foreground"
          style={{ animationDelay: '300ms' }}
        />
      </div>
    </div>
  );
}

export const TypingIndicator = memo(TypingIndicatorComponent);
