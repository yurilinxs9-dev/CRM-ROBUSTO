import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  buildLeadSyncPatch,
  type ConversationSnapshot,
  type LeadSyncPatch,
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
      // last_customer_message_at NÃO entra aqui incondicionalmente — ver
      // updateMany forward-only abaixo. `last_message_at` pode avançar/voltar
      // livremente: só serve pra ordenação de "última atividade", não elege
      // dono de nada.
      update: {
        last_message_at: occurredAt,
      },
      select: { id: true, responsavel_id: true },
    });

    // last_customer_message_at só pode AVANÇAR. `occurredAt` aqui é hora de
    // PROCESSAMENTO, não do evento — BullMQ reentrega webhook com backoff
    // (webhooks.module.ts), então uma redelivery tardia de uma mensagem
    // antiga não pode pular na frente de uma mensagem mais recente já
    // processada e reeleger essa conversa como ativa. É o mesmo roubo de
    // lead que o guard `isFromMe` evita, chegando por outra porta.
    // `updateMany` com `where` condicional faz o avanço ser atômico sem
    // outra leitura antes (evita race entre ler e decidir se avança).
    // TODO(follow-up): usar o timestamp real do provider em vez do de
    // processamento fecharia a janela de vez; não faz parte deste fix.
    if (!isFromMe) {
      await this.prisma.conversation.updateMany({
        where: {
          id: conversation.id,
          OR: [
            { last_customer_message_at: null },
            { last_customer_message_at: { lt: occurredAt } },
          ],
        },
        data: { last_customer_message_at: occurredAt },
      });
    }

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
   *
   * Retorna o patch REALMENTE aplicado (ou `null` se não havia conversa pra
   * sincronizar, ou se a sincronização falhou). O chamador usa o valor de
   * retorno pra emitir WS — não os valores computados antes de chamar este
   * método — porque a conversa ativa é RE-DERIVADA aqui dentro da transação e
   * pode divergir do que o chamador tinha em mãos (ex.: mensagem concorrente
   * chegando por outra instância). Erros continuam sendo engolidos e logados
   * (mesmo contrato de antes) para não derrubar a ingestão da mensagem; o
   * chamador simplesmente não emite nada quando recebe `null`.
   */
  async syncLeadFromActive(leadId: string): Promise<LeadSyncPatch | null> {
    try {
      return await this.prisma.$transaction(async (tx) => {
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
        if (!patch) return null;

        await tx.lead.update({
          where: { id: leadId },
          data: {
            responsavel_id: patch.responsavel_id,
            instancia_whatsapp: patch.instancia_whatsapp,
          },
        });

        return patch;
      });
    } catch (err) {
      this.logger.error(
        `sync do lead ${leadId} a partir da conversa ativa falhou — o dono exibido no card pode estar desatualizado até a próxima mensagem do cliente: ${String(err)}`,
      );
      return null;
    }
  }

  /**
   * Trava da IA por conversa, espelhando no lead para os leitores atuais.
   *
   * As duas escritas vão na MESMA transação: se `Conversation.ai_blocked` e
   * `Lead.ai_blocked` divergirem, nada mais re-deriva esse estado depois (ao
   * contrário de `syncLeadFromActive`), então sucesso parcial deixaria a IA
   * respondendo mesmo após um humano assumir. A falha continua sendo
   * engolida (mesmo padrão de `inbound-message.service.ts`): um erro ao
   * travar a IA não pode derrubar a ingestão da mensagem.
   */
  async blockAi(conversationId: string, leadId: string): Promise<void> {
    try {
      await this.prisma.$transaction([
        this.prisma.conversation.update({
          where: { id: conversationId },
          data: { ai_blocked: true },
        }),
        this.prisma.lead.update({
          where: { id: leadId },
          data: { ai_blocked: true },
        }),
      ]);
    } catch (err) {
      this.logger.warn(
        `ai_blocked na conversa ${conversationId} / lead ${leadId}: ${String(err)}`,
      );
    }
  }
}
