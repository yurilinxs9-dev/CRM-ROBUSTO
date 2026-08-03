import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  buildLeadSyncPatch,
  type ConversationSnapshot,
} from './conversation-routing';

export interface ResolveForInboundInput {
  tenantId: string;
  leadId: string;
  instanceName: string;
  /** Dono a usar SE a conversa for criada agora. Ignorado se já existe. */
  defaultResponsavelId: string | null;
  isFromMe: boolean;
  occurredAt: Date;
}

/**
 * Toda escrita de Conversation passa por aqui. O webhook não fala com a tabela
 * direto — assim a regra de "quem é o dono" fica num lugar só.
 */
@Injectable()
export class ConversationService {
  private readonly logger = new Logger(ConversationService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Encontra (ou cria) a conversa daquele lead naquela instância.
   *
   * O `update` NUNCA mexe em `responsavel_id`: uma vez que a conversa tem dono,
   * só ação humana (claim/reassign) troca. `last_customer_message_at` só avança
   * com mensagem do cliente — é ela que elege a conversa ativa.
   */
  async resolveForInbound(
    input: ResolveForInboundInput,
  ): Promise<{ id: string; responsavel_id: string | null }> {
    const { tenantId, leadId, instanceName, defaultResponsavelId, isFromMe, occurredAt } =
      input;

    const conversation = await this.prisma.conversation.upsert({
      where: {
        lead_instancia: { lead_id: leadId, instancia_whatsapp: instanceName },
      },
      create: {
        lead_id: leadId,
        instancia_whatsapp: instanceName,
        responsavel_id: defaultResponsavelId,
        tenant_id: tenantId,
        last_message_at: occurredAt,
        last_customer_message_at: isFromMe ? null : occurredAt,
      },
      update: {
        last_message_at: occurredAt,
        ...(isFromMe ? {} : { last_customer_message_at: occurredAt }),
      },
      select: { id: true, responsavel_id: true },
    });

    return conversation;
  }

  /**
   * Espelha no Lead o dono e a instância da conversa ativa.
   *
   * Leitura e escrita vão na MESMA transação: se dois workers processarem
   * mensagens do mesmo lead ao mesmo tempo, cada um deriva de um snapshot
   * consistente em vez de misturar leitura velha com escrita nova.
   *
   * A transação estreita a janela mas não a fecha (READ COMMITTED). Isso é
   * aceitável porque o valor é sempre RE-DERIVADO do banco: se duas mensagens
   * do cliente chegarem no mesmo instante por instâncias diferentes, a próxima
   * mensagem corrige. Não há estado acumulado para corromper.
   */
  async syncLeadFromActive(leadId: string): Promise<void> {
    try {
      await this.prisma.$transaction(async (tx) => {
        const rows = await tx.conversation.findMany({
          where: { lead_id: leadId },
          select: {
            id: true,
            instancia_whatsapp: true,
            responsavel_id: true,
            last_customer_message_at: true,
          },
        });

        const patch = buildLeadSyncPatch(rows as ConversationSnapshot[]);
        if (!patch) return;

        await tx.lead.update({
          where: { id: leadId },
          data: {
            responsavel_id: patch.responsavel_id,
            instancia_whatsapp: patch.instancia_whatsapp,
          },
        });
      });
    } catch (err) {
      this.logger.warn(
        `sync do lead ${leadId} a partir da conversa ativa falhou: ${String(err)}`,
      );
    }
  }

  /** Trava da IA por conversa, espelhando no lead para os leitores atuais. */
  async blockAi(conversationId: string, leadId: string): Promise<void> {
    await this.prisma.conversation
      .update({ where: { id: conversationId }, data: { ai_blocked: true } })
      .catch((err) =>
        this.logger.warn(`ai_blocked na conversa ${conversationId}: ${String(err)}`),
      );
    await this.prisma.lead
      .update({ where: { id: leadId }, data: { ai_blocked: true } })
      .catch((err) => this.logger.warn(`ai_blocked no lead ${leadId}: ${String(err)}`));
  }
}
