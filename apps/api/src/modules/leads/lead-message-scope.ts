import type { Prisma } from '@prisma/client';

/**
 * Recorte de visibilidade das mensagens de um lead para um usuário. Era o
 * miolo de `LeadsService.getMessages`; extraído para que timeline e galeria de
 * mídia apliquem EXATAMENTE a mesma regra do chat. Sem Prisma aqui: quem chama
 * resolve conversas e instâncias próprias antes (só quando não supervisiona).
 */
export interface MessageScopeLead {
  responsavel_id: string | null;
  instancia_whatsapp: string | null;
  assumed_at: Date | null;
  is_private: boolean;
}

export interface MessageScopeCtx {
  userId: string;
  role: string;
  focusMode: boolean;
  shareHistoryEnabled: boolean;
  poolEnabled: boolean;
  ownConversationIds: string[];
  ownedInstances: string[];
}

const MANAGER_ROLES = new Set(['GERENTE', 'SUPER_ADMIN']);

export function isManagerRoleName(role: string): boolean {
  return MANAGER_ROLES.has(role);
}

/**
 * Gerente sem foco vê tudo. Gerente focado abre mão da visão total — MENOS em
 * lead sem dono, onde ler a conversa é o insumo da distribuição.
 */
export function isSupervising(lead: MessageScopeLead, role: string, focusMode: boolean): boolean {
  return isManagerRoleName(role) && (!focusMode || lead.responsavel_id === null);
}

/**
 * `null` = nenhuma mensagem visível. `{}` = visão total. `{ AND: [...] }` =
 * cortes por conversa e/ou por histórico anterior ao claim.
 */
export function buildMessageScope(
  lead: MessageScopeLead,
  ctx: MessageScopeCtx,
): Prisma.MessageWhereInput | null {
  // Lead privado: só o responsável atual lê. Nem outros gerentes.
  if (lead.is_private && lead.responsavel_id !== ctx.userId) return null;

  const isManager = isManagerRoleName(ctx.role);
  const isResponsavel = lead.responsavel_id === ctx.userId;
  const supervising = isSupervising(lead, ctx.role, ctx.focusMode);

  // Operador (e gerente focado) segue restrito a leads onde é responsável OU
  // que tenham conversa própria OU cuja instância seja dele. Sem nenhum dos
  // três: nada a ver aqui.
  if (!supervising) {
    const accessibleByInstance =
      !!lead.instancia_whatsapp && ctx.ownedInstances.includes(lead.instancia_whatsapp);
    if (ctx.ownConversationIds.length === 0 && !isResponsavel && !accessibleByInstance) {
      return null;
    }
  }

  // Histórico antes do claim só é escondido de OPERADOR; tenant com
  // share_history_enabled (ex.: Diplapel) desliga o corte — quem recebe o lead
  // transferido vê a conversa inteira pra dar sequência.
  const hideHistory = !isManager && !!lead.assumed_at && !ctx.shareHistoryEnabled;

  // Visão total da conversa (todas as instâncias): gerente supervisionando ou
  // dono no modo COMPARTILHADO. No INDIVIDUAL o dono comum vê só as conversas
  // dele — era o vazamento original do espelhamento.
  // O ramo `conversation_id: null` é de TRANSIÇÃO: mensagens anteriores ao
  // backfill ainda não têm conversation_id, e sem ele quem acessa pela própria
  // instância perderia todo o histórico. Vira código morto quando a coluna
  // conversation_id passar a NOT NULL.
  const conversationScope: Prisma.MessageWhereInput | null =
    supervising || (isResponsavel && ctx.poolEnabled)
      ? null
      : {
          OR: [
            { conversation_id: { in: ctx.ownConversationIds } },
            { conversation_id: null, instance_name: { in: ctx.ownedInstances } },
          ],
        };
  const historyScope: Prisma.MessageWhereInput | null = hideHistory
    ? {
        OR: [
          { created_at: { gte: lead.assumed_at as Date } },
          { visible_to_user_id: ctx.userId },
        ],
      }
    : null;
  const scopes = [conversationScope, historyScope].filter(
    (scope): scope is Prisma.MessageWhereInput => scope !== null,
  );
  return scopes.length ? { AND: scopes } : {};
}
