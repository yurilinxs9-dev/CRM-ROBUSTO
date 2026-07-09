'use client';

import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getSocket } from '@/lib/socket';

/**
 * Provider global de eventos WS pro dashboard.
 *
 * Monta uma vez quando user está logado (fica vivo entre rotas).
 *
 * Estratégia: DELTA-PATCH em vez de refetch. O evento `lead:new-message`
 * já carrega a mensagem inteira — dá pra atualizar o lead direto na cache
 * do React Query (preview, não-lidas, ultima_interacao, reordenar) sem
 * bater no servidor. Antes cada mensagem invalidava a lista inteira
 * (até 10k leads × N abas × N usuários) — era a maior causa de lentidão.
 *
 * Refetch completo só quando: lead não está em nenhuma cache (lead novo)
 * ou reconexão do socket (eventos perdidos no gap).
 */

type WsMessage = {
  lead_id?: string;
  type?: string;
  content?: string | null;
  direction?: 'INCOMING' | 'OUTGOING';
  created_at?: string;
};

type ListLead = {
  id: string;
  mensagens_nao_lidas?: number;
  ultima_interacao?: string | null;
  ultimo_mensagem?: string;
  last_customer_message_at?: string | null;
  last_agent_message_at?: string | null;
  [key: string]: unknown;
};

/** Mesmo mapeamento de preview do backend (leads.service). */
function previewOf(msg: WsMessage): string {
  switch (msg.type) {
    case 'TEXT':
      return msg.content ?? '';
    case 'IMAGE':
      return '📷 Imagem';
    case 'VIDEO':
      return '🎥 Vídeo';
    case 'AUDIO':
      return '🎵 Áudio';
    case 'DOCUMENT':
      return '📄 Documento';
    case 'STICKER':
      return 'Figurinha';
    case 'LOCATION':
      return '📍 Localização';
    default:
      return msg.content ?? '';
  }
}

function patchLead(lead: ListLead, msg: WsMessage, now: string): ListLead {
  const incoming = msg.direction === 'INCOMING';
  return {
    ...lead,
    ultimo_mensagem: previewOf(msg),
    ultima_interacao: msg.created_at ?? now,
    mensagens_nao_lidas: incoming
      ? (lead.mensagens_nao_lidas ?? 0) + 1
      : 0,
    ...(incoming
      ? { last_customer_message_at: msg.created_at ?? now }
      : { last_agent_message_at: msg.created_at ?? now }),
  };
}

export function SocketEventsProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient();

  useEffect(() => {
    const socket = getSocket();

    // Throttle só pro caminho de invalidate (lead novo / reconexão).
    const WINDOW = 2000;
    let lastRun = 0;
    let trailing: ReturnType<typeof setTimeout> | null = null;

    const invalidateAll = () => {
      lastRun = Date.now();
      queryClient.invalidateQueries({ queryKey: ['chat', 'leads'] });
      queryClient.invalidateQueries({ queryKey: ['leads'] });
    };

    const scheduleInvalidate = () => {
      const elapsed = Date.now() - lastRun;
      if (elapsed >= WINDOW) {
        invalidateAll();
      } else if (!trailing) {
        trailing = setTimeout(() => {
          trailing = null;
          invalidateAll();
        }, WINDOW - elapsed);
      }
    };

    /**
     * Atualiza o lead em todas as listas cacheadas (chat + kanban).
     * Trata dois formatos: array simples (kanban) e InfiniteData com
     * pages (chat paginado). A ordenação visual é responsabilidade das
     * páginas (ambas ordenam/agrupam client-side em useMemo).
     * Retorna true se encontrou em pelo menos uma.
     */
    const patchArray = (
      list: ListLead[],
      leadId: string,
      apply: (lead: ListLead) => ListLead,
    ): ListLead[] | null => {
      const idx = list.findIndex((l) => l && l.id === leadId);
      if (idx === -1) return null;
      const next = [...list];
      next[idx] = apply(next[idx]);
      return next;
    };

    const patchLists = (
      leadId: string,
      apply: (lead: ListLead) => ListLead,
    ): boolean => {
      let found = false;
      for (const prefix of [['chat', 'leads'], ['leads']] as const) {
        queryClient.setQueriesData<unknown>({ queryKey: prefix }, (old: unknown) => {
          if (Array.isArray(old)) {
            const next = patchArray(old as ListLead[], leadId, apply);
            if (next) found = true;
            return next ?? old;
          }
          const inf = old as { pages?: ListLead[][] } | undefined;
          if (inf?.pages && Array.isArray(inf.pages)) {
            let changed = false;
            const pages = inf.pages.map((page) => {
              if (!Array.isArray(page)) return page;
              const next = patchArray(page, leadId, apply);
              if (next) changed = true;
              return next ?? page;
            });
            if (changed) {
              found = true;
              return { ...inf, pages };
            }
            return old;
          }
          // Board do kanban com janela por coluna: { leads, stage_counts, ... }
          const board = old as { leads?: ListLead[] } | undefined;
          if (board?.leads && Array.isArray(board.leads)) {
            const next = patchArray(board.leads, leadId, apply);
            if (next) {
              found = true;
              return { ...board, leads: next };
            }
          }
          return old;
        });
      }
      return found;
    };

    const onNewMessage = (payload: { leadId?: string; message?: WsMessage }) => {
      const leadId = payload?.leadId ?? payload?.message?.lead_id;
      if (!leadId) return;
      const msg = payload.message ?? {};
      const now = new Date().toISOString();
      const found = patchLists(leadId, (lead) => patchLead(lead, msg, now));
      // Lead ainda não está em nenhuma lista (lead novo chegando) → refetch.
      if (!found) scheduleInvalidate();
    };

    const onUnreadReset = (payload: { leadId?: string }) => {
      if (!payload?.leadId) return;
      patchLists(payload.leadId, (lead) => ({ ...lead, mensagens_nao_lidas: 0 }));
    };

    const onLeadUpdated = (payload: { leadId?: string } & Record<string, unknown>) => {
      if (!payload?.leadId) return;
      const { leadId, ...fields } = payload;
      const found = patchLists(leadId, (lead) => ({ ...lead, ...fields }));
      if (!found) scheduleInvalidate();
    };

    // Reconexão: eventos do gap foram perdidos — refetch completo.
    const onConnect = () => scheduleInvalidate();

    socket.on('lead:new-message', onNewMessage);
    socket.on('lead:unread-reset', onUnreadReset);
    socket.on('lead:updated', onLeadUpdated);
    socket.on('connect', onConnect);

    return () => {
      socket.off('lead:new-message', onNewMessage);
      socket.off('lead:unread-reset', onUnreadReset);
      socket.off('lead:updated', onLeadUpdated);
      socket.off('connect', onConnect);
      if (trailing) clearTimeout(trailing);
    };
  }, [queryClient]);

  return <>{children}</>;
}
