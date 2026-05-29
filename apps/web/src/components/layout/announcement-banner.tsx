'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Info, AlertTriangle, Wrench, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '@/lib/api';

interface Announcement {
  id: string;
  title: string;
  body: string;
  level: 'INFO' | 'WARNING' | 'MAINTENANCE';
}

const STYLES: Record<string, { bg: string; color: string; icon: LucideIcon }> = {
  INFO: { bg: 'rgba(14,165,233,0.12)', color: '#0ea5e9', icon: Info },
  WARNING: { bg: 'rgba(245,158,11,0.12)', color: '#f59e0b', icon: AlertTriangle },
  MAINTENANCE: { bg: 'rgba(239,68,68,0.12)', color: '#ef4444', icon: Wrench },
};

const KEY = 'announce-dismissed';

/** Banner de avisos da plataforma (manutenção/instabilidade/recado) — pra todos. */
export function AnnouncementBanner() {
  const { data = [] } = useQuery<Announcement[]>({
    queryKey: ['announcements-active'],
    queryFn: async () => (await api.get<Announcement[]>('/api/announcements/active')).data,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });

  const [dismissed, setDismissed] = useState<string[]>([]);
  useEffect(() => {
    try {
      setDismissed(JSON.parse(localStorage.getItem(KEY) || '[]'));
    } catch {
      /* noop */
    }
  }, []);

  const visible = data.filter((a) => !dismissed.includes(a.id));
  if (visible.length === 0) return null;

  const dismiss = (id: string) => {
    const next = [...dismissed, id];
    setDismissed(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* noop */
    }
  };

  return (
    <div className="flex flex-col">
      {visible.map((a) => {
        const s = STYLES[a.level] ?? STYLES.INFO;
        const Icon = s.icon;
        return (
          <div
            key={a.id}
            className="flex items-start gap-3 border-b px-4 py-2.5 text-sm md:px-6"
            style={{ background: s.bg, borderColor: 'var(--border-default)' }}
          >
            <Icon size={18} style={{ color: s.color }} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className="font-semibold" style={{ color: s.color }}>{a.title}</span>
              <span className="text-foreground/80"> — {a.body}</span>
            </div>
            <button
              type="button"
              onClick={() => dismiss(a.id)}
              className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
              aria-label="Dispensar aviso"
            >
              <X size={16} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
