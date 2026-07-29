import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BroadcastSenderService } from './broadcast-sender.service';

/**
 * Erros de CONFIGURAÇÃO da IA (sem modelo default, modelo removido/inativo).
 * Não são erros do alvo: sem pausa, o cron queimaria todos os alvos em
 * 'failed', 1 por janela, sem ninguém perceber.
 */
function isAiConfigError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes('Nenhum modelo de IA') || msg.includes('Modelo de IA não encontrado');
}

/**
 * Motor de envio do follow-up/broadcast. Roda a cada minuto e, para cada
 * broadcast 'running':
 *  - respeita o LIMITE DIÁRIO (daily_limit, reset meia-noite BRT): atingiu o
 *    teto, o broadcast fica 'running' em espera e retoma sozinho no dia
 *    seguinte (envios manuais "agora" também contam no teto);
 *  - respeita o INTERVALO (throttle_seconds, padrão 15min): no máximo um alvo
 *    por janela.
 * O envio em si (guardas + conteúdo + status) é do BroadcastSenderService —
 * mesma lógica do envio manual.
 */
@Injectable()
export class BroadcastDispatcher {
  private readonly logger = new Logger(BroadcastDispatcher.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sender: BroadcastSenderService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    const now = new Date();
    const running = await this.prisma.broadcast.findMany({ where: { status: 'running' } });

    for (const b of running) {
      // Throttle: só dispara se passou throttle_seconds desde o último envio.
      if (b.last_dispatch_at) {
        const elapsed = (now.getTime() - b.last_dispatch_at.getTime()) / 1000;
        if (elapsed < b.throttle_seconds) continue;
      }

      // Limite diário: atingiu o teto → espera o próximo dia (não vira done).
      const sentToday = await this.sender.sentToday(b.id);
      if (sentToday >= b.daily_limit) continue;

      const target = await this.prisma.broadcastTarget.findFirst({
        where: { broadcast_id: b.id, status: 'pending' },
        orderBy: { created_at: 'asc' },
      });

      if (!target) {
        await this.prisma.broadcast.update({ where: { id: b.id }, data: { status: 'done' } });
        continue;
      }

      try {
        await this.sender.sendToTarget(b, target);
      } catch (err) {
        this.logger.error(`Broadcast ${b.id} alvo ${target.id} falhou: ${String(err)}`);
        if (isAiConfigError(err)) {
          // Problema de config, não do lead: pausa o broadcast e mantém o alvo
          // pendente. O gerente corrige o modelo e dá Play de novo.
          await this.prisma.broadcast.update({ where: { id: b.id }, data: { status: 'paused' } });
          continue;
        }
        await this.prisma.broadcastTarget.update({
          where: { id: target.id },
          data: { status: 'failed', error: String(err).slice(0, 500) },
        });
      }

      // Consome a janela de throttle independentemente do resultado do alvo.
      await this.prisma.broadcast.update({ where: { id: b.id }, data: { last_dispatch_at: new Date() } });
    }
  }
}
