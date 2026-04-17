'use client';

import { memo, useState } from 'react';
import { Play } from 'lucide-react';

interface VideoBubbleProps {
  src: string;
  poster?: string | null;
  thumbnail?: string | null;
}

function VideoBubbleComponent({ src, poster, thumbnail }: VideoBubbleProps) {
  const [showPlayer, setShowPlayer] = useState(false);
  const posterUrl = poster || thumbnail;

  if (showPlayer || !posterUrl) {
    return (
      <video
        src={src}
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
