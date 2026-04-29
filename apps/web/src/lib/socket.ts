import { io, Socket } from 'socket.io-client';

let socket: Socket | null = null;
const joinedLeads = new Set<string>();
let isRefreshingToken = false;

function readStoredToken(): string {
  if (typeof window === 'undefined') return '';
  return localStorage.getItem('accessToken') ?? '';
}

/**
 * Best-effort token refresh para socket reconnect. Não importa axios direto
 * pra evitar dep cíclico — usa fetch nativo. Se /refresh falhar, retorna
 * null e o socket fica em stand-by até user navegar (axios interceptor
 * dispara o /login redirect via 401 na próxima request HTTP).
 */
async function refreshTokenForSocket(): Promise<string | null> {
  if (isRefreshingToken) return null;
  isRefreshingToken = true;
  try {
    const baseUrl = process.env.NEXT_PUBLIC_API_URL || '';
    const res = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      credentials: 'include',
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { accessToken?: string };
    const newToken = data?.accessToken;
    if (!newToken) return null;
    if (typeof window !== 'undefined') {
      localStorage.setItem('accessToken', newToken);
    }
    return newToken;
  } catch {
    return null;
  } finally {
    isRefreshingToken = false;
  }
}

export function getSocket(): Socket {
  if (!socket) {
    socket = io(process.env.NEXT_PUBLIC_WS_URL || 'http://187.127.11.117:3001', {
      // Permite polling fallback em proxies/redes que bloqueiam ws puro.
      transports: ['websocket', 'polling'],
      auth: {
        token: readStoredToken(),
      },
      autoConnect: false,
      // Reconnect agressivo mas com backoff: 500ms → 5s, infinitas tentativas.
      // Aguenta deploys de backend (~30s downtime) sem precisar de F5.
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      randomizationFactor: 0.5,
      timeout: 20000,
    });

    // Re-join salas de leads em todo connect — cobre reconnect por queda
    // de rede, deploy de backend e reconnectSocket após token refresh.
    socket.on('connect', () => {
      joinedLeads.forEach((id) => socket!.emit('join:lead', id));
    });

    // Quando o servidor desconecta explicitamente (rebuild, kick), o
    // io-client NÃO tenta reconnect automaticamente — precisa chamar
    // s.connect() manualmente. Sem isso, deploy de backend deixava o
    // usuário com socket morto até dar F5.
    socket.on('disconnect', (reason) => {
      if (reason === 'io server disconnect' || reason === 'transport close') {
        // Pequeno delay pra backend terminar de subir.
        setTimeout(() => socket?.connect(), 800);
      }
    });

    // JWT expirado / inválido → gateway responde com erro de auth.
    // Tenta refresh do access token via cookie httpOnly e reconecta com
    // o novo. Se refresh falhar, deixa quieto — próximo XHR HTTP cuida
    // do redirect pra /login via interceptor do axios.
    socket.on('connect_error', async (err) => {
      const msg = (err as Error)?.message ?? '';
      const looksLikeAuth =
        /jwt|auth|token|unauthor/i.test(msg) || msg === 'xhr poll error';
      if (!looksLikeAuth) return;
      const newToken = await refreshTokenForSocket();
      if (!newToken || !socket) return;
      socket.auth = { token: newToken };
      socket.connect();
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
 * Reconnect com token novo. Chamado após token refresh pra
 * o gateway aceitar a conexão.
 */
export function reconnectSocket(token: string): void {
  const s = getSocket();
  s.auth = { token };
  if (s.connected) {
    // Força reconnect limpo pra o gateway re-validar o token.
    s.disconnect();
  }
  s.connect();
}

export function disconnectSocket(): void {
  if (socket) {
    socket.disconnect();
    socket = null;
    joinedLeads.clear();
  }
}

export function joinLead(leadId: string): void {
  joinedLeads.add(leadId);
  const s = getSocket();
  if (s.connected) s.emit('join:lead', leadId);
  // Se não conectado, o listener 'connect' do getSocket() emite o join.
}

export function leaveLead(leadId: string): void {
  joinedLeads.delete(leadId);
  const s = getSocket();
  if (s.connected) s.emit('leave:lead', leadId);
}
