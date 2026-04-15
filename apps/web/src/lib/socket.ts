import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_WS_URL || 'http://187.127.11.117:3001', {
      // Forca websocket puro: sem isso o cliente tenta long-polling primeiro,
      // o que adiciona ~1-2s de handshake e aumenta a carga no backend.
      transports: ['websocket'],
      upgrade: false,
      auth: {
        token: typeof window !== 'undefined' ? localStorage.getItem('accessToken') : '',
      },
      autoConnect: false,
      reconnectionDelay: 500,
      reconnectionDelayMax: 3000,
    });
  }
  return socket;
}

export function connectSocket(token: string): Socket {
  const s = getSocket();
  s.auth = { token };
  if (!s.connected) {
    s.connect();
  }
  return s;
}

/**
 * Reconnect the socket with a fresh token. Called after token refresh
 * so the gateway accepts the new connection with a valid JWT.
 */
export function reconnectSocket(token: string): void {
  const s = getSocket();
  s.auth = { token };
  if (s.connected) {
    // Force a clean reconnect so the gateway validates the new token.
    s.disconnect();
  }
  s.connect();
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

export function joinLead(leadId: string): void {
  const s = getSocket();
  const emitJoin = () => s.emit('join:lead', leadId);
  if (s.connected) {
    emitJoin();
  } else {
    s.once('connect', emitJoin);
  }
}

export function leaveLead(leadId: string): void {
  const s = getSocket();
  if (s.connected) {
    s.emit('leave:lead', leadId);
  }
}
