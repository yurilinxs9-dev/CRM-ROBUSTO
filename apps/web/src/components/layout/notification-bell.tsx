'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Bell, CheckCheck } from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { ptBR } from 'date-fns/locale';
import { api } from '@/lib/api';
import { getSocket } from '@/lib/socket';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface Notif {
  id: string;
  titulo: string;
  conteudo: string;
  tipo: string;
  lida: boolean;
  link?: string | null;
  created_at: string;
}

function timeAgo(date: string): string {
  try {
    return formatDistanceToNowStrict(new Date(date), { locale: ptBR, addSuffix: true });
  } catch {
    return '';
  }
}

export function NotificationBell() {
  const qc = useQueryClient();
  const router = useRouter();

  const { data: items = [] } = useQuery<Notif[]>({
    queryKey: ['notifications'],
    queryFn: async () => (await api.get<Notif[]>('/api/notifications')).data,
    refetchInterval: 60_000,
    staleTime: 10_000,
  });

  const unread = items.filter((n) => !n.lida).length;

  useEffect(() => {
    const s = getSocket();
    const onNew = () => qc.invalidateQueries({ queryKey: ['notifications'] });
    s.on('notification:new', onNew);
    return () => {
      s.off('notification:new', onNew);
    };
  }, [qc]);

  const markRead = useMutation({
    mutationFn: (id: string) => api.patch(`/api/notifications/${id}/read`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });
  const markAll = useMutation({
    mutationFn: () => api.patch('/api/notifications/read-all'),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }),
  });

  const openNotif = (n: Notif) => {
    if (!n.lida) markRead.mutate(n.id);
    if (n.link) router.push(n.link);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative" aria-label="Notificações">
          <Bell className="h-5 w-5" />
          {unread > 0 && (
            <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 p-0">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">Notificações</span>
          {unread > 0 && (
            <button
              type="button"
              onClick={() => markAll.mutate()}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              Marcar todas lidas
            </button>
          )}
        </div>

        <div className="max-h-96 overflow-y-auto">
          {items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-3 py-10 text-center text-muted-foreground">
              <Bell className="h-7 w-7 opacity-40" />
              <p className="text-sm">Nenhuma notificação</p>
            </div>
          ) : (
            items.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => openNotif(n)}
                className="flex w-full items-start gap-2.5 border-b px-3 py-2.5 text-left transition-colors hover:bg-accent"
              >
                <span
                  className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${n.lida ? 'bg-transparent' : 'bg-primary'}`}
                  aria-hidden
                />
                <span className="min-w-0 flex-1">
                  <span className={`block truncate text-sm ${n.lida ? 'font-medium' : 'font-semibold'}`}>
                    {n.titulo}
                  </span>
                  <span className="block truncate text-xs text-muted-foreground">{n.conteudo}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{timeAgo(n.created_at)}</span>
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
