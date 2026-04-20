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

    // ── Diagnostic logging ──────────────────────────────────────────────────
    const logFileRef = (ref: string) => ref.startsWith('data:') ? `data:audio/ogg;base64,[${Math.round(ref.length * 0.75 / 1024)}KB]` : `...${ref.slice(-50)}`;

    let res: Awaited<ReturnType<typeof postPayload>>;
    const t0 = Date.now();
    let usedStrategy = strategy;
    if (strategy === 'base64') {
      const buf = await this.fetchAsBase64(freshUrl);
      const fileRef = `data:audio/ogg;base64,${buf}`;
      this.logger.log(`[handleAudio] REQ strategy=base64 payload=${JSON.stringify({ ...payload(logFileRef(fileRef)), msgId: d.messageId })}`);
      res = await postPayload(fileRef);
    } else {
      const reqPayload = payload(freshUrl);
      this.logger.log(`[handleAudio] REQ strategy=${strategy} payload=${JSON.stringify({ ...reqPayload, file: logFileRef(freshUrl), msgId: d.messageId })}`);
      try {
        res = await postPayload(freshUrl);
      } catch (err) {
        if (strategy === 'auto') {
          this.logger.warn(`[handleAudio] URL strategy failed (${(err as Error).message}); retrying with base64`);
          usedStrategy = 'base64-fallback';
          const buf = await this.fetchAsBase64(freshUrl);
          res = await postPayload(`data:audio/ogg;base64,${buf}`);
        } else {
          throw err;
        }
      }
    }
    const elapsed = Date.now() - t0;
    this.logger.log(`[handleAudio] RES status=${res.status} elapsed=${elapsed}ms strategy=${usedStrategy} body=${JSON.stringify(res.data)}`);
    // ── End diagnostic logging ────────���─────────────────────────────────────

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
