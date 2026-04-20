'use client';

import { memo } from 'react';
import { AlertCircle, Loader2 } from 'lucide-react';
import { useMediaBlob } from './use-media-blob';

interface MediaImageProps {
  messageId: string;
  signedUrl?: string | null;
  alt?: string;
  onOpenPreview?: () => void;
}

function MediaImageComponent({ messageId, signedUrl, alt = 'Imagem', onOpenPreview }: MediaImageProps) {
  const { blobUrl, loading, error } = useMediaBlob(messageId, signedUrl);

  if (error) {
    return (
      <div className="flex h-32 w-72 max-w-full items-center justify-center gap-2 rounded-lg bg-muted/30 text-xs text-muted-foreground">
        <AlertCircle size={14} />
        <span>Imagem não disponível</span>
      </div>
    );
  }

  if (loading || !blobUrl) {
    return (
      <div className="flex h-48 w-72 max-w-full items-center justify-center rounded-lg bg-muted/20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={onOpenPreview}
      className="block overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
      aria-label="Abrir imagem"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={blobUrl}
        alt={alt}
        width={288}
        height={288}
        loading="lazy"
        decoding="async"
        className="h-auto max-h-72 w-72 max-w-full object-cover"
      />
    </button>
  );
}

export const MediaImage = memo(MediaImageComponent);
