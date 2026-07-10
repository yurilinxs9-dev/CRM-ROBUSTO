import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Dias de retenção do payload bruto de webhook. 30d cobre qualquer diagnóstico
 *  retroativo razoável; sem isso a tabela vira o maior objeto do banco
 *  (chegou a 1.7GB / 65% do Supabase em jul/2026). */
const RETENTION_DAYS = 30;
/** Lote por delete — evita lock longo e WAL gigante num delete único. */
const BATCH = 40_000;

@Injectable()
export class WebhookLogRetentionService {
  private readonly logger = new Logger(WebhookLogRetentionService.name);

  constructor(private prisma: PrismaService) {}

  /** 03:30 — fora do horário comercial e antes dos crons de 04:00. */
  @Cron('30 3 * * *')
  async purgeOldLogs() {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    let total = 0;
    try {
      // deleteMany não aceita LIMIT — loop com subquery raw pra manter lotes.
      for (;;) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM "WebhookLog"
          WHERE id IN (
            SELECT id FROM "WebhookLog"
            WHERE created_at < ${cutoff}
            LIMIT ${BATCH}
          )`;
        total += n;
        if (n < BATCH) break;
      }
      if (total > 0) {
        this.logger.log(`WebhookLog retention: ${total} logs >${RETENTION_DAYS}d removidos`);
      }
    } catch (err) {
      this.logger.error(`WebhookLog retention falhou: ${String(err)}`);
    }
  }
}
