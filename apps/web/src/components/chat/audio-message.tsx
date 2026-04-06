'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/cn';

interface AudioMessageProps {
  messageId: string;
  /** Legacy direct URL — used as fallback if the proxy fetch fails. */
  src?: string;
  isOutgoing?: boolean;
}

const SPEEDS = [1, 1.5, 2] as const;

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function AudioMessageComponent({ messageId, src, isOutgoing = false }: AudioMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);

  // Fetch audio bytes via authenticated backend proxy, then expose as blob URL.
  useEffect(() => {
    let disposed = false;
    let createdUrl: string | null = null;
    setError(false);
    setReady(false);
    setResolvedSrc(null);

    (async () => {
      try {
        const token =
          typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
        const res = await fetch(`/api/messages/${messageId}/media`, {
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          credentials: 'include',
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const blob = await res.blob();
        if (disposed) return;
        createdUrl = URL.createObjectURL(blob);
        setResolvedSrc(createdUrl);
      } catch {
        if (disposed) return;
        if (src) {
          setResolvedSrc(src);
        } else {
          setError(true);
        }
      }
    })();

    return () => {
      disposed = true;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [messageId, src]);

  useEffect(() => {
    if (!resolvedSrc) return;
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ws: any;

    (async () => {
      if (!containerRef.current) return;
      const WaveSurfer = (await import('wavesurfer.js')).default;
      if (disposed || !containerRef.current) return;
      const instance = WaveSurfer.create({
        container: containerRef.current,
        waveColor: isOutgoing ? 'rgba(255,255,255,0.4)' : 'rgba(148,163,184,0.5)',
        progressColor: isOutgoing ? '#ffffff' : 'hsl(var(--primary))',
        cursorColor: 'transparent',
        height: 32,
        barWidth: 2,
        barGap: 2,
        barRadius: 2,
        normalize: true,
      });
      instance.on('ready', () => {
        setDuration(instance.getDuration());
        setReady(true);
      });
      instance.on('audioprocess', () => setCurrent(instance.getCurrentTime()));
      instance.on('seeking', () => setCurrent(instance.getCurrentTime()));
      instance.on('play', () => setPlaying(true));
      instance.on('pause', () => setPlaying(false));
      instance.on('finish', () => {
        setPlaying(false);
        setCurrent(0);
      });
      instance.on('error', () => setError(true));
      instance.load(resolvedSrc);
      ws = instance;
      wsRef.current = instance;
    })();

    return () => {
      disposed = true;
      ws?.destroy?.();
      wsRef.current = null;
    };
  }, [resolvedSrc, isOutgoing]);

  const toggle = () => {
    wsRef.current?.playPause();
  };

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    wsRef.current?.setPlaybackRate(SPEEDS[next], false);
  };

  if (error) {
    return (
      <div className="flex min-w-[220px] items-center gap-2 text-xs opacity-80">
        <AlertCircle size={14} />
        <span>Áudio não está mais disponível</span>
      </div>
    );
  }

  return (
    <div className="flex min-w-[220px] items-center gap-3">
      <button
        type="button"
        onClick={toggle}
        disabled={!ready}
        aria-label={playing ? 'Pausar áudio' : 'Reproduzir áudio'}
        className={cn(
          'flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-full transition-colors',
          isOutgoing
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
          !ready && 'opacity-60',
        )}
      >
        {!ready ? (
          <Loader2 size={16} className="animate-spin" />
        ) : playing ? (
          <Pause size={16} />
        ) : (
          <Play size={16} className="ml-0.5" />
        )}
      </button>
      <div className="min-w-0 flex-1">
        <div ref={containerRef} className="w-full" />
        <div className="mt-1 flex items-center justify-between text-[10px] opacity-80">
          <span>{formatDuration(playing || current > 0 ? current : duration)}</span>
          <button
            type="button"
            onClick={cycleSpeed}
            aria-label="Mudar velocidade"
            className="rounded px-1.5 py-0.5 text-[10px] font-semibold hover:bg-black/10 dark:hover:bg-white/10"
          >
            {SPEEDS[speedIdx]}x
          </button>
        </div>
      </div>
    </div>
  );
}

export const AudioMessage = memo(AudioMessageComponent);
