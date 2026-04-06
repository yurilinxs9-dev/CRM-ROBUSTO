'use client';

import { useEffect, useRef, useState } from 'react';
import { Pause, Play } from 'lucide-react';
import { cn } from '@/lib/cn';

type WaveSurferInstance = Awaited<
  typeof import('wavesurfer.js')
>['default'] extends { create: (...args: unknown[]) => infer R }
  ? R
  : unknown;

interface AudioMessageProps {
  src: string;
  isOutgoing?: boolean;
}

const SPEEDS = [1, 1.5, 2] as const;

function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export function AudioMessage({ src, isOutgoing = false }: AudioMessageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const wsRef = useRef<any>(null);
  const [playing, setPlaying] = useState(false);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);
  const [speedIdx, setSpeedIdx] = useState(0);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let disposed = false;
    let ws: unknown;

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
      instance.load(src);
      ws = instance;
      wsRef.current = instance;
    })();

    return () => {
      disposed = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (ws as any)?.destroy?.();
      wsRef.current = null;
    };
  }, [src, isOutgoing]);

  const toggle = () => {
    wsRef.current?.playPause();
  };

  const cycleSpeed = () => {
    const next = (speedIdx + 1) % SPEEDS.length;
    setSpeedIdx(next);
    wsRef.current?.setPlaybackRate(SPEEDS[next], false);
  };

  return (
    <div className="flex items-center gap-3 min-w-[220px]">
      <button
        type="button"
        onClick={toggle}
        disabled={!ready}
        aria-label={playing ? 'Pausar áudio' : 'Reproduzir áudio'}
        className={cn(
          'h-9 w-9 rounded-full flex items-center justify-center flex-shrink-0 transition-colors',
          isOutgoing
            ? 'bg-white/20 text-white hover:bg-white/30'
            : 'bg-primary text-primary-foreground hover:bg-primary/90',
          !ready && 'opacity-60',
        )}
      >
        {playing ? <Pause size={16} /> : <Play size={16} className="ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
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
