import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_WS_URL || 'http://187.127.11.117:3001', {
      transports: ['websocket', 'polling'],
      auth: {
        token: typeof window !== 'undefined' ? localStorage.getItem('accessToken') : '',
      },
      autoConnect: false,
    });
  }
  return socket;
}

export function connectSocket(token: string): Socket {
  const s = getSocket();
  s.auth = { token };
  s.connect();
  return s;
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
