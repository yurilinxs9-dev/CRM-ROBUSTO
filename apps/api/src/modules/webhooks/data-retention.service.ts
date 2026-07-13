import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';

/** Dias de retenção do payload bruto de webhook. 7d cobre o diagnóstico
 *  retroativo real (investigações usam horas/dias, não semanas); com 30d a
 *  tabela chegou a 832MB — maior objeto do banco (jul/2026). */
const WEBHOOK_LOG_RETENTION_DAYS = 7;
/** Dias mantendo `metadata.raw` (payload bruto do provider) nas mensagens.
 *  Depois disso o raw é removido, preservando as demais chaves do metadata
 *  (send_error, location, contact) — são elas que os fluxos de retry e UI
 *  consomem. Sem essa poda o metadata.raw custou ~500MB (jul/2026). */
const MESSAGE_RAW_RETENTION_DAYS = 30;
/** Lote por delete — evita lock longo e WAL gigante num delete único. */
const DELETE_BATCH = 40_000;
/** Lote por update de jsonb — rewrite de row+TOAST é mais caro que delete. */
const UPDATE_BATCH = 10_000;

/** Retenção de dados de diagnóstico (WebhookLog, Message.metadata.raw).
 *  Mantém o Supabase dentro do orçamento sem perder capacidade de debug
 *  recente. Crons às 03:3x — fora do horário comercial, antes dos de 04:00. */
@Injectable()
export class DataRetentionService {
  private readonly logger = new Logger(DataRetentionService.name);

  constructor(private prisma: PrismaService) {}

  @Cron('30 3 * * *')
  async purgeOldWebhookLogs() {
    const cutoff = this.cutoff(WEBHOOK_LOG_RETENTION_DAYS);
    let total = 0;
    try {
      // deleteMany não aceita LIMIT — loop com subquery raw pra manter lotes.
      for (;;) {
        const n = await this.prisma.$executeRaw`
          DELETE FROM "WebhookLog"
          WHERE id IN (
            SELECT id FROM "WebhookLog"
            WHERE created_at < ${cutoff}
            LIMIT ${DELETE_BATCH}
          )`;
        total += n;
        if (n < DELETE_BATCH) break;
      }
      if (total > 0) {
        this.logger.log(
          `WebhookLog retention: ${total} logs >${WEBHOOK_LOG_RETENTION_DAYS}d removidos`,
        );
      }
    } catch (err) {
      this.logger.error(`WebhookLog retention falhou: ${String(err)}`);
    }
  }

  @Cron('45 3 * * *')
  async pruneMessageRawMetadata() {
    const cutoff = this.cutoff(MESSAGE_RAW_RETENTION_DAYS);
    let total = 0;
    try {
      for (;;) {
        const n = await this.prisma.$executeRaw`
          UPDATE "Message"
          SET metadata = metadata - 'raw'
          WHERE id IN (
            SELECT id FROM "Message"
            WHERE created_at < ${cutoff}
              AND metadata IS NOT NULL
              AND jsonb_exists(metadata, 'raw')
            LIMIT ${UPDATE_BATCH}
          )`;
        total += n;
        if (n < UPDATE_BATCH) break;
      }
      if (total > 0) {
        this.logger.log(
          `Message raw retention: metadata.raw removido de ${total} msgs >${MESSAGE_RAW_RETENTION_DAYS}d`,
        );
      }
    } catch (err) {
      this.logger.error(`Message raw retention falhou: ${String(err)}`);
    }
  }

  private cutoff(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  }
}
