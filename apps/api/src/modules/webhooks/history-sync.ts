type Obj = Record<string, unknown>;

/**
 * Helpers puros do history sync UazAPI (espelho WhatsApp Web). O servidor
 * uazapiGO guarda o histórico de chats/mensagens; estes helpers interpretam as
 * respostas de POST /chat/find e POST /message/find pra decidir o que
 * re-injetar na fila de webhooks. Zero IO — testável sem Nest.
 * Spec: docs/superpowers/specs/2026-08-20-history-sync-design.md.
 */

/** Chat individual candidato a sync, já normalizado. */
export interface SyncChat {
  chatid: string;
  phone: string;
  /** Melhor nome disponível (agenda > pushName) — usado pra placeholder. */
  name: string | null;
  /**
   * Nome salvo na AGENDA do aparelho (wa_contactName). É o que o WhatsApp
   * Web exibe — vale mais que o pushName do perfil do cliente, senão a
   * operadora procura "Fernanda Greick" e o CRM mostra o nome de perfil.
   */
  contactName: string | null;
  lidJid: string | null;
  lastMsgTs: number;
}

const asStr = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 ? v : null;

/**
 * Normaliza uma página de POST /chat/find. Descarta grupos, chats sem JID
 * `@s.whatsapp.net` e telefones fora de 8-13 dígitos (mesma régua do
 * resolvedor de @lid do Evolution — dígitos de LID viram lead fantasma).
 */
export function parseChatsPage(raw: unknown): SyncChat[] {
  const list = (raw as Obj | undefined)?.chats;
  if (!Array.isArray(list)) return [];
  const out: SyncChat[] = [];
  for (const item of list) {
    const c = item as Obj;
    if (c.wa_isGroup === true) continue;
    const chatid = asStr(c.wa_chatid);
    if (!chatid || !chatid.endsWith('@s.whatsapp.net')) continue;
    const phone = chatid.split('@')[0].split(':')[0].replace(/\D/g, '');
    if (phone.length < 8 || phone.length > 13) continue;
    const lid = asStr(c.wa_chatlid);
    out.push({
      chatid,
      phone,
      name: asStr(c.wa_contactName) ?? asStr(c.name),
      contactName: asStr(c.wa_contactName),
      lidJid: lid && lid.endsWith('@lid') ? lid : null,
      lastMsgTs: messageTs({ messageTimestamp: c.wa_lastMsgTimestamp }),
    });
  }
  return out;
}

/**
 * Margem entre o carimbo oficial do WhatsApp e o created_at local. Precisa ser
 * generosa: mensagem OUTGOING enviada pelo CRM nasce no banco ANTES de o
 * WhatsApp carimbar (medido em produção: 3-4s de diferença em disparos).
 * Margem menor vira falso gap eterno — o mesmo lote é re-injetado a cada
 * passada (o upsert dedupa, mas o trabalho se repete). Buraco real nos
 * últimos segundos fica pro webhook ao vivo, que é quem cobre o presente.
 */
const GAP_SKEW_MS = 10_000;

/**
 * O chat tem mensagem que o CRM não viu? `dbLastMs` é o created_at da última
 * Message do par (tenant, telefone) — null quando o lead nem existe.
 */
export function chatHasGap(
  chat: SyncChat,
  dbLastMs: number | null,
  sinceMs: number,
): boolean {
  if (chat.lastMsgTs < sinceMs) return false;
  if (dbLastMs === null) return true;
  return chat.lastMsgTs > dbLastMs + GAP_SKEW_MS;
}

/** Normaliza uma página de POST /message/find. */
export function parseFindMessages(raw: unknown): {
  messages: Obj[];
  hasMore: boolean;
  nextOffset: number;
} {
  const o = raw as Obj | undefined;
  const list = o?.messages;
  if (!Array.isArray(list)) return { messages: [], hasMore: false, nextOffset: 0 };
  return {
    messages: list as Obj[],
    hasMore: o?.hasMore === true,
    nextOffset: typeof o?.nextOffset === 'number' ? o.nextOffset : list.length,
  };
}

/**
 * messageTimestamp da UazAPI em epoch MS; alguns servidores emitem em
 * segundos — abaixo de 10^12 é tratado como segundos e convertido.
 */
export function messageTs(m: Obj): number {
  const v = m.messageTimestamp;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return 0;
  return v < 1e12 ? v * 1000 : v;
}

/**
 * Payload do job `uazapi.messages` re-injetado na fila `webhooks` — mesmo
 * contrato do webhook ao vivo, mais a flag `backfill` que o
 * InboundMessageService usa pra preservar timestamp e calar notificações.
 */
export function backfillJobPayload(message: Obj, token: string): Obj {
  return { event: 'uazapi.messages', token, message, backfill: true };
}
