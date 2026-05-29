'use client';

import { useEffect, useState } from 'react';
import { getSocket } from '@/lib/socket';

/**
 * Estado de conexão do WebSocket, reativo. Usado pra mostrar "Reconectando…"
 * pro usuário quando o realtime cai (igual WhatsApp Web mostra "Conectando").
 */
export function useSocketStatus(): boolean {
  const [connected, setConnected] = useState(true);

  useEffect(() => {
    const s = getSocket();
    setConnected(s.connected);

    const onConnect = () => setConnected(true);
    const onDisconnect = () => setConnected(false);

    s.on('connect', onConnect);
    s.on('disconnect', onDisconnect);
    s.io.on('reconnect_attempt', onDisconnect);

    return () => {
      s.off('connect', onConnect);
      s.off('disconnect', onDisconnect);
      s.io.off('reconnect_attempt', onDisconnect);
    };
  }, []);

  return connected;
}
