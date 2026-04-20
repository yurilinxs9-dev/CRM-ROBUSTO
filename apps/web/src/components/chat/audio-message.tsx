'use client';

import { memo, useEffect, useRef, useState } from 'react';
import { AlertCircle, Loader2, Pause, Play } from 'lucide-react';
import { cn } from '@/lib/cn';

interface AudioMessageProps {
  messageId: string;
  /** Signed URL or storage path — component resolves it automatically. */
  src?: string;
  isOutgoing?: boolean;
  /** Pre-computed waveform peaks (0-1 normalized). Skips WaveSurfer decode. */
  waveformPeaks?: number[] | null;
}

const SPEEDS = [1, 1.5, 2] as const;
const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/** Resolve audio source to a blob URL (same-origin, avoids cross-origin decode issues). */
async function resolveAudioBlob(
  messageId: string,
  src?: string,
): Promise<string> {
  // 1) If src is already a signed URL, fetch it as a blob directly.
  if (src && /^https?:\/\//i.test(src)) {
    const res = await fetch(src);
    if (res.ok) {
      const blob = await res.blob();
      return URL.createObjectURL(blob);
    }
    // Signed URL failed — fall through to proxy.
    console.warn(`[AudioMessage] direct fetch failed (${res.status}), trying proxy`);
  }

  // 2) Fall back to backend proxy.
  const token =
    typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
  const proxyUrl = `${API_BASE}/api/messages/${messageId}/media`;
  const proxyRes = await fetch(proxyUrl, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: 'include',
  });
  if (!proxyRes.ok) throw new Error(`proxy ${proxyRes.status}`);
  const blob = await proxyRes.blob();
  return URL.createObjectURL(blob);
}

function AudioMessageComponent({ messageId, src, isOutgoing = false, waveformPeaks }: AudioMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);

  // Resolve audio source to a blob URL.
  useEffect(() => {
    let disposed = false;
    let url: string | null = null;
    setError(false);
    setReady(false);
    setBlobUrl(null);

    if (!src && !messageId) {
      setError(true);
      return;
    }

    resolveAudioBlob(messageId, src)
      .then((created) => {
        if (disposed) { URL.revokeObjectURL(created); return; }
        url = created;
        setBlobUrl(created);
      })
      .catch((err) => {
        if (disposed) return;
        console.error(`[AudioMessage] resolve failed for msg=${messageId}:`, err);
        setError(true);
      });

    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [messageId, src]);

  // Create WaveSurfer instance from blob URL.
  useEffect(() => {
    if (!blobUrl) return;
    let disposed = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ws: any;

    (async () => {
      if (!containerRef.current) return;
      const WaveSurfer = (await import('wavesurfer.js')).default;
      if (disposed || !containerRef.current) return;
      const hasPeaks = waveformPeaks && waveformPeaks.length > 0;
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
        ...(hasPeaks ? { peaks: [waveformPeaks] } : {}),
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
      instance.on('error', (e: unknown) => {
        console.error(`[AudioMessage] WaveSurfer error for msg=${messageId}:`, e);
        setError(true);
      });
      instance.load(blobUrl);
      ws = instance;
      wsRef.current = instance;
    })();

    return () => {
      disposed = true;
      ws?.destroy?.();
      wsRef.current = null;
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blobUrl, isOutgoing, waveformPeaks]);

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
          <span>{formatDuration(current > 0 ? current : duration)}</span>
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
