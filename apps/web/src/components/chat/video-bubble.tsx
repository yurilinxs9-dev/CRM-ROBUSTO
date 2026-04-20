'use client';

import { memo, useState } from 'react';
import { Loader2, Play } from 'lucide-react';
import { useMediaBlob } from './use-media-blob';

interface VideoBubbleProps {
  messageId: string;
  src: string;
  poster?: string | null;
  thumbnail?: string | null;
}

function VideoBubbleComponent({ messageId, src, poster, thumbnail }: VideoBubbleProps) {
  const [showPlayer, setShowPlayer] = useState(false);
  const { blobUrl, loading, error } = useMediaBlob(messageId, src);
  const posterUrl = poster || thumbnail;

  if (loading) {
    return (
      <div className="flex h-48 max-w-xs items-center justify-center rounded-lg bg-muted/20">
        <Loader2 size={20} className="animate-spin text-muted-foreground" />
      </div>
    );
  }

  const videoSrc = blobUrl || src;

  if (error && !src) {
    return (
      <div className="flex h-32 max-w-xs items-center justify-center rounded-lg bg-muted/30 text-xs text-muted-foreground">
        Vídeo não disponível
      </div>
    );
  }

  if (showPlayer || !posterUrl) {
    return (
      <video
        src={videoSrc}
        controls
        autoPlay={!!posterUrl}
        preload="metadata"
        className="max-h-80 max-w-xs rounded-lg"
      />
    );
  }

  return (
    <button
      type="button"
      onClick={() => setShowPlayer(true)}
      className="group/video relative block max-h-80 max-w-xs overflow-hidden rounded-lg focus:outline-none focus:ring-2 focus:ring-ring"
      aria-label="Reproduzir vídeo"
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={posterUrl}
        alt="Prévia do vídeo"
        className="h-auto max-h-80 w-full object-cover"
        loading="lazy"
        decoding="async"
      />
      <div className="absolute inset-0 flex items-center justify-center bg-black/20 transition group-hover/video:bg-black/30">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-black/50 text-white backdrop-blur-sm transition group-hover/video:scale-110">
          <Play size={28} className="ml-1" fill="white" />
        </div>
      </div>
    </button>
  );
}

export const VideoBubble = memo(VideoBubbleComponent);
