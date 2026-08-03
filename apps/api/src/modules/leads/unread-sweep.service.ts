import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';

// Leitura no celular não gera evento na UazAPI (wa_unreadCount é contador
// server-side, só reseta via API). Conversa atendida 100% pelo aparelho, com o
// cliente dando a última palavra ("ok, obrigado"), ficaria "Aguardando" no
// board pra sempre. Depois de STALE_HOURS sem msg nova do cliente, presume-se
// tratada e o contador expira. Alertas de tempo-de-resposta disparam em horas,
// muito antes desta janela — o sweep não os encobre.
const DEFAULT_STALE_HOURS = 48;

@Injectable()
export class UnreadSweepService {
  private readonly logger = new Logger(UnreadSweepService.name);
  private readonly staleHours = Number(process.env.UNREAD_STALE_HOURS) || DEFAULT_STALE_HOURS;

  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: CrmGateway,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweep() {
    const cutoff = new Date(Date.now() - this.staleHours * 3_600_000);

    const stale = await this.prisma.lead.findMany({
      where: {
        mensagens_nao_lidas: { gt: 0 },
        last_customer_message_at: { not: null, lt: cutoff },
      },
      select: { id: true, tenant_id: true },
    });
    if (stale.length === 0) return;

    await this.prisma.lead.updateMany({
      where: { id: { in: stale.map((l) => l.id) } },
      data: { mensagens_nao_lidas: 0 },
    });

    for (const lead of stale) {
      this.gateway.emitLeadUnreadReset(lead.id, lead.tenant_id);
    }
    this.logger.log(`Unread sweep: ${stale.length} leads expirados (> ${this.staleHours}h sem msg nova do cliente)`);
  }
}
