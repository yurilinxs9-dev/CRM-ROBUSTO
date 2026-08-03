/**
 * Roteamento de conversa — funções PURAS, sem Prisma/IO, para serem testáveis
 * em isolamento (mesmo padrão de `leads/lead-visibility.ts`).
 *
 * A conversa ATIVA de um lead é a que recebeu a última mensagem DO CLIENTE.
 * Mensagem enviada pelo vendedor — manual, follow-up ou IA — não muda quem é a
 * ativa: senão um disparo automático pela instância antiga puxaria o card de
 * volta sem o cliente ter procurado ninguém.
 */

export interface ConversationSnapshot {
  id: string;
  instancia_whatsapp: string;
  responsavel_id: string | null;
  last_customer_message_at: Date | null;
}

export interface LeadSyncPatch {
  responsavel_id: string | null;
  instancia_whatsapp: string;
}

/**
 * Conversa ativa = maior `last_customer_message_at`. Conversas sem mensagem do
 * cliente ficam por último. Empate desempata por `id` (ordem estável, para o
 * resultado não depender da ordem em que o Prisma devolveu as linhas).
 */
export function resolveActiveConversation(
  conversations: ConversationSnapshot[],
): ConversationSnapshot | null {
  if (conversations.length === 0) return null;

  return conversations.reduce((best, current) => {
    const bestAt = best.last_customer_message_at?.getTime() ?? null;
    const currentAt = current.last_customer_message_at?.getTime() ?? null;

    if (bestAt === currentAt) return current.id < best.id ? current : best;
    if (bestAt === null) return current;
    if (currentAt === null) return best;
    return currentAt > bestAt ? current : best;
  });
}

/**
 * Campos derivados que o Lead deve espelhar da conversa ativa. `null` quando o
 * lead não tem conversa nenhuma — nesse caso o chamador NÃO deve tocar no lead.
 */
export function buildLeadSyncPatch(
  conversations: ConversationSnapshot[],
): LeadSyncPatch | null {
  const active = resolveActiveConversation(conversations);
  if (!active) return null;
  return {
    responsavel_id: active.responsavel_id,
    instancia_whatsapp: active.instancia_whatsapp,
  };
}
