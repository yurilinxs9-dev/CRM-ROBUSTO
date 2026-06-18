import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagesService } from './messages.service';

/**
 * Rede de segurança para envio estável.
 *
 * O envio já tem 4 tentativas inline (BullMQ, backoff 10/20/40s) que cobrem
 * instabilidade curta da UazAPI. Esta varredura cuida da cauda longa: mensagens
 * que ficaram FAILED por uma queda mais demorada (ex.: UazAPI 503 por minutos).
 *
 * Estratégia BALANCEADA (baixo risco de duplicata): só reenvia falhas de
 * NÃO-ENTREGA CLARA — HTTP 503/502/500/429 ou conexão recusada. Timeouts (a msg
 * pode ter sido entregue e só a resposta se perdeu) NÃO são reenviados aqui.
 * Cada mensagem é reenviada no máximo MAX_RESENDS vezes, espaçadas por COOLDOWN.
 */
@Injectable()
export class MessagesRecoveryService {
  private readonly logger = new Logger(MessagesRecoveryService.name);

  /** Falhas de não-entrega clara → seguro reenviar (UazAPI não chegou a mandar). */
  private static readonly TRANSIENT_STATUS = new Set([429, 500, 502, 503]);
  private static readonly TRANSIENT_CODE = new Set(['ECONNREFUSED', 'EAI_AGAIN']);

  private static readonly MAX_RESENDS = 5;
  private static readonly COOLDOWN_MS = 90_000;       // espaço mínimo entre reenvios
  private static readonly MAX_AGE_MS = 60 * 60_000;   // não ressuscita falha > 1h
  private static readonly BATCH = 50;

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async sweep(): Promise<void> {
    const since = new Date(Date.now() - MessagesRecoveryService.MAX_AGE_MS);
    const candidates = await this.prisma.message.findMany({
      where: {
        status: 'FAILED',
        direction: 'OUTGOING',
        is_internal_note: false,
        whatsapp_message_id: null,
        created_at: { gt: since },
      },
      orderBy: { created_at: 'asc' },
      take: MessagesRecoveryService.BATCH,
      select: { id: true, metadata: true },
    });
    if (candidates.length === 0) return;

    let resent = 0;
    for (const c of candidates) {
      if (!this.isEligible(c.metadata)) continue;
      try {
        const r = await this.messages.resend(c.id, {}); // modo sistema
        if (r.status === 'PENDING') {
          resent++;
          this.logger.log(`reenviada msg ${c.id} (recuperação automática)`);
        }
      } catch (err) {
        // Ex.: nenhuma instância conectada agora — deixa pro próximo ciclo
        // (resend_count NÃO foi incrementado, então não consome tentativa).
        this.logger.debug(`skip resend ${c.id}: ${(err as Error).message}`);
      }
    }
    if (resent > 0) this.logger.log(`varredura de recuperação: ${resent}/${candidates.length} reenviadas`);
  }

  /** Decide se uma falha entra na recuperação automática. */
  private isEligible(metadata: unknown): boolean {
    const m = (metadata && typeof metadata === 'object') ? (metadata as Record<string, unknown>) : {};

    const count = typeof m.resend_count === 'number' ? m.resend_count : 0;
    if (count >= MessagesRecoveryService.MAX_RESENDS) return false;

    const last = typeof m.last_resend_at === 'string' ? Date.parse(m.last_resend_at) : NaN;
    if (!Number.isNaN(last) && Date.now() - last < MessagesRecoveryService.COOLDOWN_MS) return false;

    const status = typeof m.send_error_status === 'number' ? m.send_error_status : null;
    const code = typeof m.send_error_code === 'string' ? m.send_error_code : null;
    const transient =
      (status !== null && MessagesRecoveryService.TRANSIENT_STATUS.has(status)) ||
      (code !== null && MessagesRecoveryService.TRANSIENT_CODE.has(code));
    return transient;
  }
}
