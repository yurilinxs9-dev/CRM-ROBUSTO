type Obj = Record<string, unknown>;

/** Mensagem outbound do CRM presa em SENT, candidata a reconciliação. */
export interface DbOutbound {
  id: string;
  wamid: string;
  createdAt: Date;
}

/** Mensagem como a UazAPI devolve em POST /message/find (campos que usamos). */
export interface ServerMessage {
  messageid: string;
  fromMe: boolean;
  status: string; // 'Sent' | 'Delivered' | 'Read' | 'Played' | ''
  messageTimestamp: number; // epoch ms
}

export type ReconcileAction =
  | { id: string; action: 'DELIVERED' | 'READ' }
  /** Presa: servidor ainda 'Sent' mas msg posterior no MESMO chat já entregou. */
  | { id: string; action: 'STUCK' };

const SERVER_STATUS_MAP: Record<string, 'DELIVERED' | 'READ'> = {
  Delivered: 'DELIVERED',
  Read: 'READ',
  Played: 'READ',
};

export function parseServerMessages(raw: unknown): ServerMessage[] {
  const list = (raw as Obj | undefined)?.messages;
  if (!Array.isArray(list)) return [];
  const out: ServerMessage[] = [];
  for (const item of list) {
    const m = item as Obj;
    const messageid = typeof m.messageid === 'string' ? m.messageid : '';
    if (!messageid) continue;
    out.push({
      messageid,
      fromMe: m.fromMe === true,
      status: typeof m.status === 'string' ? m.status : '',
      messageTimestamp: typeof m.messageTimestamp === 'number' ? m.messageTimestamp : 0,
    });
  }
  return out;
}

/**
 * Decide o que fazer com cada outbound SENT de um chat, dado o estado real no
 * servidor UazAPI.
 *
 * - Servidor diz Delivered/Read/Played → atualiza (o webhook messages_update
 *   deste servidor uazapiGO vem como ReadReceipt SEM message id, então o ack
 *   nunca chega por push — só por esta reconciliação).
 * - Servidor ainda 'Sent' NÃO significa falha: destinatário offline é 'Sent'
 *   legítimo. Só é STUCK quando uma mensagem fromMe POSTERIOR no mesmo chat já
 *   consta Delivered/Read (prova de que o canal funciona e esta foi pulada —
 *   bug de sessão do uazapiGO no primeiro contato) e a msg tem mais de
 *   `stuckAfterMs`.
 * - Não encontrada no servidor → sem ação (pode estar fora da janela do find).
 */
export function planReconciliation(
  dbMsgs: DbOutbound[],
  serverMsgs: ServerMessage[],
  opts: { now: number; stuckAfterMs: number },
): ReconcileAction[] {
  const byId = new Map(serverMsgs.map((m) => [m.messageid, m]));
  const deliveredFromMeTs: number[] = serverMsgs
    .filter((m) => m.fromMe && SERVER_STATUS_MAP[m.status] !== undefined)
    .map((m) => m.messageTimestamp);

  const actions: ReconcileAction[] = [];
  for (const db of dbMsgs) {
    const sv = byId.get(db.wamid);
    if (!sv) continue;

    const mapped = SERVER_STATUS_MAP[sv.status];
    if (mapped) {
      actions.push({ id: db.id, action: mapped });
      continue;
    }

    if (sv.status !== 'Sent') continue;
    if (opts.now - db.createdAt.getTime() < opts.stuckAfterMs) continue;
    const laterDelivered = deliveredFromMeTs.some((ts) => ts > sv.messageTimestamp);
    if (laterDelivered) actions.push({ id: db.id, action: 'STUCK' });
  }
  return actions;
}
