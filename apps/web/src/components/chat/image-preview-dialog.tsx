'use client';

import { useState } from 'react';
import { Loader2, ZoomIn, ZoomOut, X } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useMediaBlob } from './use-media-blob';

interface ImagePreviewDialogProps {
  src: string | null;
  alt?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  messageId?: string;
}

export function ImagePreviewDialog({
  src,
  alt = 'Imagem',
  open,
  onOpenChange,
  messageId,
}: ImagePreviewDialogProps) {
  const [scale, setScale] = useState(1);
  const { blobUrl, loading } = useMediaBlob(messageId ?? '', src);

  const reset = () => setScale(1);
  const zoomIn = () => setScale((s) => Math.min(s + 0.25, 4));
  const zoomOut = () => setScale((s) => Math.max(s - 0.25, 0.5));

  const displaySrc = blobUrl || src;

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        onOpenChange(v);
        if (!v) reset();
      }}
    >
      <DialogContent className="max-w-[95vw] p-0 sm:max-w-4xl">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <div className="relative flex h-[85vh] items-center justify-center overflow-hidden bg-black/90">
          {loading && (
            <Loader2 size={32} className="animate-spin text-white" />
          )}
          {!loading && displaySrc && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={displaySrc}
              alt={alt}
              draggable={false}
              className="max-h-full max-w-full select-none object-contain transition-transform"
              style={{ transform: `scale(${scale})` }}
            />
          )}
          <div className="absolute bottom-4 left-1/2 flex -translate-x-1/2 items-center gap-2 rounded-full bg-black/60 px-2 py-1 backdrop-blur">
            <Button
              variant="ghost"
              size="icon"
              onClick={zoomOut}
              className="h-8 w-8 text-white hover:bg-white/20"
              aria-label="Diminuir zoom"
            >
              <ZoomOut size={16} />
            </Button>
            <span className="min-w-[3ch] text-center text-xs text-white tabular-nums">
              {Math.round(scale * 100)}%
            </span>
            <Button
              variant="ghost"
              size="icon"
              onClick={zoomIn}
              className="h-8 w-8 text-white hover:bg-white/20"
              aria-label="Aumentar zoom"
            >
              <ZoomIn size={16} />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              onClick={() => onOpenChange(false)}
              className="h-8 w-8 text-white hover:bg-white/20"
              aria-label="Fechar"
            >
              <X size={16} />
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
