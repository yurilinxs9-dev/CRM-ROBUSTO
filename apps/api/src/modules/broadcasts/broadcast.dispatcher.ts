import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { BroadcastSenderService } from './broadcast-sender.service';
import { isWithinBroadcastWindow } from './broadcast-window';
import { classifyBroadcastError } from './broadcast-error';

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

  // A restart may leave a claimed recipient without a final result. Never
  // automatically resend an ambiguous attempt; expose it for manual review.
  @Cron(CronExpression.EVERY_10_MINUTES)
  async recoverInterrupted() {
    await this.prisma.broadcastTarget.updateMany({
      where: { status: 'pending', error_code: 'dispatching', sent_at: { lt: new Date(Date.now() - 20 * 60_000) } },
      data: { status: 'failed', error_code: 'envio_interrompido', error: 'Envio interrompido. Confira a conversa antes de tentar novamente.' },
    });
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    const now = new Date();
    const running = await this.prisma.broadcast.findMany({ where: { status: 'running' } });
    if (running.length === 0) return;

    // Uma consulta por tick, não uma por disparo.
    const tenants = await this.prisma.tenant.findMany({
      where: { id: { in: [...new Set(running.map((b) => b.tenant_id))] } },
      select: {
        id: true,
        broadcast_window_start: true,
        broadcast_window_end: true,
        broadcast_window_days: true,
      },
    });
    const janelaPorTenant = new Map(tenants.map((t) => [t.id, t]));

    for (const b of running) {
      // Fora da janela a fila apenas ESPERA: nada vira falha, nada é perdido,
      // e o throttle não é consumido — senão o primeiro disparo depois das 9h
      // ficaria esperando mais 15 minutos à toa.
      const janela = janelaPorTenant.get(b.tenant_id);
      if (!janela) {
        // Falha FECHADA: sem a linha do tenant não dá para saber o horário, e
        // um guarda contra mensagem de madrugada que falha aberto não é guarda.
        this.logger.warn(`Broadcast ${b.id}: tenant ${b.tenant_id} sem janela — disparo adiado`);
        continue;
      }
      if (
        !isWithinBroadcastWindow(
          now,
          'America/Sao_Paulo',
          janela.broadcast_window_start,
          janela.broadcast_window_end,
          janela.broadcast_window_days,
        )
      ) {
        continue;
      }

      // Throttle: só dispara se passou throttle_seconds desde o último envio.
      if (b.last_dispatch_at) {
        const elapsed = (now.getTime() - b.last_dispatch_at.getTime()) / 1000;
        if (elapsed < b.throttle_seconds) continue;
      }

      // Limite diário: atingiu o teto → espera o próximo dia (não vira done).
      const sentToday = await this.sender.sentToday(b.id);
      if (sentToday >= b.daily_limit) continue;

      const target = await this.prisma.broadcastTarget.findFirst({
        where: { broadcast_id: b.id, status: 'pending', OR: [{ error_code: null }, { error_code: { not: 'dispatching' } }] },
        orderBy: { created_at: 'asc' },
      });

      if (!target) {
        const inFlight = await this.prisma.broadcastTarget.count({ where: { broadcast_id: b.id, status: 'pending', error_code: 'dispatching' } });
        if (!inFlight) await this.prisma.broadcast.updateMany({ where: { id: b.id, status: 'running' }, data: { status: 'done' } });
        continue;
      }

      try {
        const result = await this.sender.sendToTarget(b, target);
        if (result?.outcome === 'deferred') continue;
      } catch (err) {
        this.logger.error(`Broadcast ${b.id} alvo ${target.id} falhou: ${String(err)}`);
        if (isAiConfigError(err)) {
          // Problema de config, não do lead: pausa o broadcast e mantém o alvo
          // pendente. O gerente corrige o modelo e dá Play de novo.
          await this.prisma.broadcast.updateMany({ where: { id: b.id, status: 'running' }, data: { status: 'paused' } });
          continue;
        }
        await this.prisma.broadcastTarget.update({
          where: { id: target.id },
          data: {
            status: 'failed',
            error: String(err).slice(0, 500),
            error_code: classifyBroadcastError(err),
          },
        });
      }

      // Consome a janela de throttle independentemente do resultado do alvo.
      // The sender reserves cadence atomically before handing a message to the queue.
    }
  }
}
