'use client';

import { memo, type ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface ChatWallpaperProps {
  children?: ReactNode;
  className?: string;
}

/**
 * WhatsApp-like subtle pattern background. Uses an inline SVG as a
 * CSS mask-less data URL — no network requests, tiny footprint.
 */
function ChatWallpaperComponent({ children, className }: ChatWallpaperProps) {
  return (
    <div
      className={cn(
        'relative flex-1 overflow-y-auto bg-[#efeae2] dark:bg-[#0b141a]',
        'before:pointer-events-none before:absolute before:inset-0 before:opacity-[0.06] before:[background-image:radial-gradient(circle_at_1px_1px,currentColor_1px,transparent_0)] before:[background-size:22px_22px] before:text-foreground',
        className,
      )}
    >
      <div className="relative z-10">{children}</div>
    </div>
  );
}

export const ChatWallpaper = memo(ChatWallpaperComponent);
