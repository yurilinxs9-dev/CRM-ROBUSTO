import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

const JA_CONVERSANDO = 'cliente já estava conversando';

/**
 * Reage à mensagem do CLIENTE para tirá-lo da fila do follow-up.
 *
 * Antes disto, o disparo só parava por `ai_blocked`, que é ligado quando o TIME
 * envia — nunca quando o cliente responde. Na prática o cliente dizia "já
 * comprei, obrigada" e o robô seguia cutucando a cada 15 minutos. Além do
 * constrangimento, é o comportamento que faz número ser denunciado.
 */
@Injectable()
export class BroadcastReplyService {
  private readonly logger = new Logger(BroadcastReplyService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Alvo que JÁ recebeu vira `replied` — é a métrica de conversa gerada.
   * Alvo ainda na fila vira `skipped`: o cliente escreveu por conta própria,
   * então o disparo não causou essa conversa e contá-la infla a métrica.
   *
   * Disparos `done` e `canceled` ficam intocados: histórico não muda.
   */
  async registerCustomerReply(leadId: string, tenantId?: string): Promise<{ replied: number; skipped: number }> {
    const targets = await this.prisma.broadcastTarget.findMany({
      where: {
        lead_id: leadId,
        status: { in: ['pending', 'sent'] },
        broadcast: {
          status: { in: ['running', 'paused'] },
          // Isolamento explícito: hoje o lead_id já é único por empresa, mas
          // este é o primeiro acesso a BroadcastTarget vindo de fora do módulo
          // e a garantia não deve depender disso continuar verdade.
          ...(tenantId ? { tenant_id: tenantId } : {}),
        },
      },
      select: { id: true, status: true, broadcast_id: true },
    });

    if (targets.length === 0) return { replied: 0, skipped: 0 };

    const sentIds = targets.filter((t) => t.status === 'sent').map((t) => t.id);
    const pendingIds = targets.filter((t) => t.status === 'pending').map((t) => t.id);

    // Os dois updates numa transação: se o segundo falhasse sozinho, o alvo já
    // enviado ficaria 'replied' e o pendente seguiria na fila — o disparo
    // voltaria a cutucar exatamente quem acabou de responder.
    const ops = [];
    if (sentIds.length > 0) {
      ops.push(
        this.prisma.broadcastTarget.updateMany({
          where: { id: { in: sentIds } },
          data: { status: 'replied', replied_at: new Date() },
        }),
      );
    }
    if (pendingIds.length > 0) {
      ops.push(
        this.prisma.broadcastTarget.updateMany({
          where: { id: { in: pendingIds } },
          data: { status: 'skipped', error: JA_CONVERSANDO, error_code: 'cliente_ja_conversando' },
        }),
      );
    }
    await this.prisma.$transaction(ops);

    this.logger.log(
      `Resposta do lead ${leadId}: ${sentIds.length} alvo(s) respondido(s), ${pendingIds.length} retirado(s) da fila`,
    );
    return { replied: sentIds.length, skipped: pendingIds.length };
  }
}
