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

    const handleNewMessage = () => {
      queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    };

    const handleUnreadReset = () => {
      queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    };

    socket.on('lead:new-message', handleNewMessage);
    socket.on('lead:unread-reset', handleUnreadReset);

    return () => {
      socket.off('lead:new-message', handleNewMessage);
      socket.off('lead:unread-reset', handleUnreadReset);
    };
  }, [queryClient]);

  return <>{children}</>;
}
