import { Processor, WorkerHost, OnWorkerEvent } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { PrismaService } from '../../common/prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { MediaService } from '../media/media.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import {
  MESSAGES_SEND_QUEUE,
  SendMessageJobData,
  SendTextJobData,
  SendAudioJobData,
  SendMediaJobData,
} from './messages.queue';

@Processor(MESSAGES_SEND_QUEUE, { concurrency: 5 })
export class MessagesSendProcessor extends WorkerHost {
  private readonly logger = new Logger(MessagesSendProcessor.name);

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
    private readonly media: MediaService,
    private readonly gateway: CrmGateway,
    private readonly cache: RedisCacheService,
  ) {
    super();
  }

  async process(job: Job<SendMessageJobData>): Promise<void> {
    const d = job.data;
    switch (d.kind) {
      case 'text':  return this.handleText(job as Job<SendTextJobData>);
      case 'audio': return this.handleAudio(job as Job<SendAudioJobData>);
      case 'media': return this.handleMedia(job as Job<SendMediaJobData>);
    }
  }

  private async handleText(job: Job<SendTextJobData>): Promise<void> {
    const d = job.data;
    if (await this.alreadySent(d.messageId)) {
      this.logger.warn(`[handleText] skipping retry — message ${d.messageId} already delivered`);
      return;
    }
    const res = await firstValueFrom(this.http.post<Record<string, unknown>>(
      `${d.uazBaseUrl}/send/text`,
      { number: d.telefone, text: d.content },
      { headers: { token: d.uazToken } },
    ));
    const waId = this.extractWhatsappMessageId(res.data);
    await this.prisma.message.update({
      where: { id: d.messageId },
      data: { status: 'SENT', whatsapp_message_id: waId },
    });
    this.emitStatus(d.leadId, d.messageId, 'SENT');
    await this.invalidateCache(d.leadId, d.tenantId);
  }

  private async handleAudio(job: Job<SendAudioJobData>): Promise<void> {
    const d = job.data;
    if (await this.alreadySent(d.messageId)) {
      this.logger.warn(`[handleAudio] skipping retry — message ${d.messageId} already delivered`);
      return;
    }
    // Re-sign URL in case the queue delay outran the signature TTL.
    const freshUrl = await this.media.getSignedUrl(d.storagePath, 3600);
    const pttField = process.env['UAZAPI_PTT_FIELD'] ?? 'ptt';
    const strategy = (process.env['AUDIO_SEND_STRATEGY'] ?? 'auto') as string;
    const payload = (fileRef: string): Record<string, unknown> => pttField === 'audio+ptt'
      ? { number: d.telefone, type: 'audio', ptt: true, file: fileRef }
      : { number: d.telefone, type: 'ptt', file: fileRef };

    const postPayload = async (ref: string) => firstValueFrom(this.http.post<Record<string, unknown>>(
      `${d.uazBaseUrl}/send/media`, payload(ref), { headers: { token: d.uazToken } },
    ));

    let res: Awaited<ReturnType<typeof postPayload>>;
    if (strategy === 'base64') {
      const buf = await this.fetchAsBase64(freshUrl);
      res = await postPayload(`data:audio/ogg;base64,${buf}`);
    } else {
      try {
        res = await postPayload(freshUrl);
      } catch (err) {
        if (strategy === 'auto') {
          this.logger.warn(`[handleAudio] URL strategy failed, retrying with base64`);
          const buf = await this.fetchAsBase64(freshUrl);
          res = await postPayload(`data:audio/ogg;base64,${buf}`);
        } else {
          throw err;
        }
      }
    }

    const waId = this.extractWhatsappMessageId(res.data);
    await this.prisma.message.update({
      where: { id: d.messageId },
      data: { status: 'SENT', whatsapp_message_id: waId },
    });
    this.emitStatus(d.leadId, d.messageId, 'SENT');
    await this.invalidateCache(d.leadId, d.tenantId);
  }

  private async handleMedia(job: Job<SendMediaJobData>): Promise<void> {
    const d = job.data;
    if (await this.alreadySent(d.messageId)) {
      this.logger.warn(`[handleMedia] skipping retry — message ${d.messageId} already delivered`);
      return;
    }
    const freshUrl = await this.media.getSignedUrl(d.storagePath, 3600);
    const body: Record<string, unknown> = { number: d.telefone, type: d.mediaType, file: freshUrl };
    if (d.caption)  body['text'] = d.caption;    // UazAPI uses 'text' for caption
    if (d.filename) body['docName'] = d.filename;
    const res = await firstValueFrom(this.http.post<Record<string, unknown>>(
      `${d.uazBaseUrl}/send/media`, body, { headers: { token: d.uazToken } },
    ));
    const waId = this.extractWhatsappMessageId(res.data);
    await this.prisma.message.update({
      where: { id: d.messageId },
      data: { status: 'SENT', whatsapp_message_id: waId },
    });
    this.emitStatus(d.leadId, d.messageId, 'SENT');
    await this.invalidateCache(d.leadId, d.tenantId);
  }

  @OnWorkerEvent('failed')
  async onFailed(job: Job<SendMessageJobData>, err: Error): Promise<void> {
    const attempts = job.opts?.attempts ?? 3;
    if (job.attemptsMade >= attempts) {
      this.logger.error(`[${job.name}] final failure ${job.id}: ${err.message}`);
      await this.prisma.message.update({
        where: { id: job.data.messageId },
        data: { status: 'FAILED', metadata: { send_error: err.message } as Prisma.InputJsonValue },
      }).catch((e: unknown) => this.logger.error(`failed to persist FAILED status: ${(e as Error).message}`));
      this.emitStatus(job.data.leadId, job.data.messageId, 'FAILED');
      // M4: invalidate list/history caches so UI reflects FAILED badge immediately.
      await this.invalidateCache(job.data.leadId, job.data.tenantId);
    }
  }

  /**
   * Idempotency guard: prevents BullMQ retries from re-sending a message that
   * already reached WhatsApp. The DB update step can fail with P2002 (unique
   * violation on whatsapp_message_id) when the echo webhook upserts a new row
   * before the processor commits — without this guard each retry hits UazAPI
   * again and the customer receives duplicate messages.
   */
  private async alreadySent(messageId: string): Promise<boolean> {
    const existing = await this.prisma.message.findUnique({
      where: { id: messageId },
      select: { whatsapp_message_id: true, status: true },
    });
    return Boolean(existing?.whatsapp_message_id) || existing?.status === 'SENT';
  }

  private extractWhatsappMessageId(data: unknown): string | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    return (d['id'] as string | undefined)
      ?? (d['messageId'] as string | undefined)
      ?? ((d['key'] as Record<string, unknown> | undefined)?.['id'] as string | undefined)
      ?? null;
  }

  private async fetchAsBase64(url: string): Promise<string> {
    const res = await firstValueFrom(this.http.get<ArrayBuffer>(url, { responseType: 'arraybuffer' }));
    return Buffer.from(res.data as unknown as ArrayBuffer).toString('base64');
  }

  private emitStatus(leadId: string, messageId: string, status: string): void {
    this.gateway.emitMessageStatusUpdate(leadId, messageId, status);
  }

  private async invalidateCache(leadId: string, tenantId: string): Promise<void> {
    await this.cache.delPattern?.(`messages:${leadId}:*`).catch(() => undefined);
    await this.cache.delPattern?.(`leads:list:${tenantId}:*`).catch(() => undefined);
  }
}
