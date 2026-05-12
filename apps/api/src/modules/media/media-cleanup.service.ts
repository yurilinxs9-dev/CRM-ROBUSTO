import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from './media.service';

const RETENTION_DAYS = 30;
const BATCH_SIZE = 500;

@Injectable()
export class MediaCleanupService {
  private readonly logger = new Logger(MediaCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'America/Sao_Paulo' })
  async cleanupOldMedia(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
    this.logger.log(
      `Iniciando limpeza de midia com created_at < ${cutoff.toISOString()} (retencao ${RETENTION_DAYS}d)`,
    );

    let totalProcessed = 0;
    let totalDeleted = 0;
    let totalSkipped = 0;

    for (;;) {
      const batch = await this.prisma.message.findMany({
        where: {
          created_at: { lt: cutoff },
          media_url: { not: null },
          media_archived: false,
        },
        select: {
          id: true,
          media_url: true,
          media_filename: true,
        },
        orderBy: { created_at: 'asc' },
        take: BATCH_SIZE,
      });

      if (batch.length === 0) break;

      for (const msg of batch) {
        totalProcessed++;
        const storagePath = this.resolveStoragePath(msg.media_url, msg.media_filename);

        if (!storagePath) {
          await this.markArchived(msg.id);
          totalSkipped++;
          continue;
        }

        try {
          await this.media.delete(storagePath);
          await this.markArchived(msg.id);
          totalDeleted++;
        } catch (err) {
          this.logger.warn(
            `Falha removendo ${storagePath} (msg=${msg.id}): ${(err as Error).message}`,
          );
        }
      }

      if (batch.length < BATCH_SIZE) break;
    }

    this.logger.log(
      `Limpeza concluida — processadas=${totalProcessed} deletadas=${totalDeleted} ignoradas=${totalSkipped}`,
    );
  }

  /**
   * media_url can be a raw storage path, a (possibly expired) signed Supabase
   * URL, or an external http(s) URL. Only the raw storage path is deletable
   * via Supabase SDK. media_filename holds the storage path for outgoing
   * messages.
   */
  private resolveStoragePath(
    mediaUrl: string | null,
    mediaFilename: string | null,
  ): string | null {
    if (mediaFilename && !/^https?:\/\//i.test(mediaFilename)) {
      return mediaFilename;
    }
    if (!mediaUrl) return null;
    if (!/^https?:\/\//i.test(mediaUrl)) return mediaUrl;

    const match = /\/storage\/v1\/object\/(?:sign|public)\/[^/]+\/(.+?)(?:\?|$)/.exec(
      mediaUrl,
    );
    return match?.[1] ? decodeURIComponent(match[1]) : null;
  }

  private async markArchived(messageId: string): Promise<void> {
    await this.prisma.message.update({
      where: { id: messageId },
      data: { media_url: null, media_archived: true },
    });
  }
}
