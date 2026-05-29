'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';

/**
 * Provider global de eventos WS pro dashboard.
 *
 * Monta uma vez quando user está logado (fica vivo entre rotas)
 * e invalida queryKeys relevantes ao receber eventos do servidor.
 *
 * Antes existia esse handler em chat/page.tsx, mas desmontava
 * ao entrar em /chat/[id], deixando lista de conversas e kanban
 * sem realtime quando user navegava.
 */
export function SocketEventsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    // Throttle leading+trailing: o 1º evento invalida na hora (lista atualiza
    // instantâneo), eventos seguintes dentro da janela são coalescidos num
    // único refetch ao final — evita tempestade de refetch de 10k leads quando
    // chegam muitas mensagens em rajada.
    const WINDOW = 800;
    let lastRun = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    const run = () => {
      lastRun = Date.now();
      queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    };

    const schedule = () => {
      const elapsed = Date.now() - lastRun;
      if (elapsed >= WINDOW) {
        run();
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          run();
        }, WINDOW - elapsed);
      }
    };

    socket.on('lead:new-message', schedule);
    socket.on('lead:unread-reset', schedule);
    // Ao reconectar, eventos do gap foram perdidos — refetch a lista/kanban.
    socket.on('connect', schedule);

    return () => {
      socket.off('lead:new-message', schedule);
      socket.off('lead:unread-reset', schedule);
      socket.off('connect', schedule);
      if (trailing) clearTimeout(trailing);
    };
  }, [queryClient]);

  return <>{children}</>;
}
