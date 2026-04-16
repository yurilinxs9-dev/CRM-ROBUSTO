import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { AudioService } from '../media/audio.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import type { AuthUser } from '../../common/types/auth-user';
import { firstValueFrom } from 'rxjs';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { MessageType } from '@prisma/client';

const sendTextSchema = z.object({
  lead_id: z.string().uuid(),
  content: z.string().min(1),
});

const internalNoteSchema = z.object({
  lead_id: z.string().uuid(),
  content: z.string().min(1),
});

interface InstanceConfig {
  uazapi_token?: string;
  uazapi_id?: string;
  [key: string]: unknown;
}

@Injectable()
export class MessagesService {
  private readonly logger = new Logger(MessagesService.name);
  private readonly baseUrl: string;

  constructor(
    private http: HttpService,
    private config: ConfigService,
    private prisma: PrismaService,
    private media: MediaService,
    private audio: AudioService,
    private gateway: CrmGateway,
    private cache: RedisCacheService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
  }

  private async resolveLeadAndToken(leadId: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome: lead.instancia_whatsapp, tenant_id: user.tenantId },
    });
    if (!instance) throw new NotFoundException('Instancia WhatsApp nao encontrada');
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException('Token UazAPI ausente para a instancia');
    return { lead, token };
  }

  async sendText(data: unknown, user: AuthUser) {
    const { lead_id, content } = sendTextSchema.parse(data);
    const { lead, token } = await this.resolveLeadAndToken(lead_id, user);

    const { data: response } = await firstValueFrom(
      this.http.post<Record<string, unknown>>(
        `${this.baseUrl}/send/text`,
        { number: lead.telefone, text: content },
        { headers: { token } },
      ),
    );

    const respKey = response?.key as Record<string, unknown> | undefined;
    const whatsappMessageId =
      (response?.id as string | undefined) ??
      (response?.messageId as string | undefined) ??
      (respKey?.id as string | undefined) ??
      uuid();

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: whatsappMessageId,
        direction: 'OUTGOING',
        type: 'TEXT',
        content,
        status: 'SENT',
        sent_by_user_id: user.id,
        tenant_id: user.tenantId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    this.gateway.emitNewMessage(lead_id, message, user.tenantId);
    await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
    return message;
  }

  async createInternalNote(data: unknown, user: AuthUser) {
    const { lead_id, content } = internalNoteSchema.parse(data);
    const lead = await this.prisma.lead.findFirst({
      where: { id: lead_id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    return this.prisma.message.create({
      data: {
        lead_id,
        instance_name: 'internal',
        whatsapp_message_id: uuid(),
        direction: 'OUTGOING',
        type: 'TEXT',
        content,
        status: 'READ',
        is_internal_note: true,
        sent_by_user_id: user.id,
        tenant_id: user.tenantId,
      },
    });
  }

  private detectMediaType(mimetype: string): { type: MessageType; uazType: 'image' | 'video' | 'document' } {
    if (mimetype.startsWith('image/')) return { type: MessageType.IMAGE, uazType: 'image' };
    if (mimetype.startsWith('video/')) return { type: MessageType.VIDEO, uazType: 'video' };
    return { type: MessageType.DOCUMENT, uazType: 'document' };
  }

  async sendAudio(file: Express.Multer.File, body: unknown, user: AuthUser) {
    const { lead_id } = z.object({ lead_id: z.string().uuid() }).parse(body);
    if (!file) throw new NotFoundException('Arquivo de audio ausente');

    const { lead, token } = await this.resolveLeadAndToken(lead_id, user);

    const opusBuffer = await this.audio.convertToOpus(file.buffer, file.mimetype);

    // Probe duration via ffprobe. Client-provided duration_seconds handled in Phase 4.
    const probedDuration = await this.audio.probeDurationSeconds(opusBuffer, 'audio/ogg');

    const filename = `audio/${lead_id}/${uuid()}.ogg`;
    await this.media.upload(filename, opusBuffer, 'audio/ogg');
    const signedUrl = await this.media.getSignedUrl(filename, 60 * 60 * 24 * 7);

    // PTT send strategy — controlled via env vars for zero-downtime tuning.
    // UAZAPI_PTT_FIELD: 'ptt' (default, type:ptt) | 'audio+ptt' (legacy fallback, type:audio+ptt:true)
    // AUDIO_SEND_STRATEGY: 'auto' (URL→base64 fallback) | 'url' | 'base64'
    const pttField = process.env.UAZAPI_PTT_FIELD ?? 'ptt';
    const rawStrategy = process.env.AUDIO_SEND_STRATEGY ?? 'auto';
    const strategy: 'auto' | 'url' | 'base64' =
      rawStrategy === 'url' || rawStrategy === 'base64' ? rawStrategy : 'auto';

    const buildPayload = (fileRef: string): Record<string, unknown> => {
      if (pttField === 'audio+ptt') {
        return { number: lead.telefone, type: 'audio', ptt: true, file: fileRef };
      }
      // default: pttField === 'ptt' — real PTT blue-mic voice note
      return { number: lead.telefone, type: 'ptt', file: fileRef };
    };

    const base64DataUri = (): string =>
      `data:audio/ogg;base64,${opusBuffer.toString('base64')}`;

    let uazRes: { data: Record<string, unknown> };
    let chosenStrategy: 'url' | 'base64';

    try {
      if (strategy === 'base64') {
        chosenStrategy = 'base64';
        uazRes = await firstValueFrom(
          this.http.post<Record<string, unknown>>(
            `${this.baseUrl}/send/media`,
            buildPayload(base64DataUri()),
            { headers: { token } },
          ),
        );
      } else {
        // 'url' or 'auto': try signed URL first
        chosenStrategy = 'url';
        try {
          uazRes = await firstValueFrom(
            this.http.post<Record<string, unknown>>(
              `${this.baseUrl}/send/media`,
              buildPayload(signedUrl),
              { headers: { token } },
            ),
          );
        } catch (urlErr: unknown) {
          if (strategy === 'auto') {
            const status = (urlErr as { response?: { status?: number } })?.response?.status;
            this.logger.warn(
              `[sendAudio] URL strategy failed (${status ?? 'no-status'}); retrying with base64`,
            );
            chosenStrategy = 'base64';
            uazRes = await firstValueFrom(
              this.http.post<Record<string, unknown>>(
                `${this.baseUrl}/send/media`,
                buildPayload(base64DataUri()),
                { headers: { token } },
              ),
            );
          } else {
            throw urlErr;
          }
        }
      }
    } catch (err) {
      this.logger.error(`UazAPI send audio failed: ${(err as Error).message}`);
      throw new BadGatewayException('Falha ao enviar audio via UazAPI');
    }

    this.logger.log(
      `[sendAudio] strategy=${chosenStrategy} duration=${probedDuration}s size=${opusBuffer.length}B`,
    );

    const response = uazRes.data;
    const respKey = response?.key as Record<string, unknown> | undefined;
    const whatsappMessageId =
      (response?.id as string | undefined) ??
      (response?.messageId as string | undefined) ??
      (respKey?.id as string | undefined) ??
      uuid();

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: whatsappMessageId,
        direction: 'OUTGOING',
        type: MessageType.AUDIO,
        content: null,
        media_url: filename,          // storage path (Phase 1) — streamMedia re-signs on read
        media_mimetype: 'audio/ogg',
        // media_filename deprecated — storage path now lives in media_url (Phase 1)
        media_size_bytes: opusBuffer.length,
        media_duration_seconds: probedDuration,
        status: 'SENT',
        sent_by_user_id: user.id,
        tenant_id: user.tenantId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    this.gateway.emitNewMessage(lead_id, message, user.tenantId);
    await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
    return message;
  }

  async sendMedia(file: Express.Multer.File, body: unknown, user: AuthUser) {
    const { lead_id, caption } = z
      .object({ lead_id: z.string().uuid(), caption: z.string().optional() })
      .parse(body);
    if (!file) throw new NotFoundException('Arquivo ausente');

    const { lead, token } = await this.resolveLeadAndToken(lead_id, user);
    const { type, uazType } = this.detectMediaType(file.mimetype);

    const safeName = file.originalname?.replace(/[^a-zA-Z0-9._-]/g, '_') ?? 'file';
    const filename = `media/${lead_id}/${uuid()}-${safeName}`;
    await this.media.upload(filename, file.buffer, file.mimetype);
    const signedUrl = await this.media.getSignedUrl(filename, 60 * 60 * 24 * 7);

    let response: Record<string, unknown>;
    try {
      const payload: Record<string, unknown> = {
        number: lead.telefone,
        type: uazType,
        file: signedUrl,
      };
      if (caption) payload.text = caption;
      if (uazType === 'document') payload.docName = file.originalname;

      const res = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${this.baseUrl}/send/media`,
          payload,
          { headers: { token } },
        ),
      );
      response = res.data;
    } catch (err) {
      this.logger.error(`UazAPI send media failed: ${(err as Error).message}`);
      throw new BadGatewayException('Falha ao enviar midia via UazAPI');
    }

    const respKey = response?.key as Record<string, unknown> | undefined;
    const whatsappMessageId =
      (response?.id as string | undefined) ??
      (response?.messageId as string | undefined) ??
      (respKey?.id as string | undefined) ??
      uuid();

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: whatsappMessageId,
        direction: 'OUTGOING',
        type,
        content: caption ?? null,
        media_url: signedUrl,
        media_mimetype: file.mimetype,
        media_filename: file.originalname ?? null,
        media_size_bytes: file.size,
        status: 'SENT',
        sent_by_user_id: user.id,
        tenant_id: user.tenantId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    this.gateway.emitNewMessage(lead_id, message, user.tenantId);
    await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
    return message;
  }

  async streamMedia(messageId: string, user: AuthUser): Promise<{
    stream: NodeJS.ReadableStream;
    contentType: string;
    contentLength?: number;
  }> {
    const message = await this.prisma.message.findFirst({
      where: { id: messageId, tenant_id: user.tenantId },
    });
    if (!message) throw new NotFoundException('Mensagem nao encontrada');
    if (!message.media_url && !message.media_filename) {
      throw new NotFoundException('Midia nao disponivel');
    }

    let upstreamUrl: string | null = null;
    // Out-going messages: `media_filename` holds the storage path (set by sendAudio/sendMedia).
    if (message.media_filename && !/^https?:\/\//i.test(message.media_filename)) {
      try {
        upstreamUrl = await this.media.getSignedUrl(message.media_filename, 60 * 60);
      } catch (err) {
        this.logger.warn(
          `Re-sign failed for ${message.media_filename}: ${(err as Error).message}`,
        );
      }
    }
    // Incoming messages from webhook.processor store the storage path in `media_url`.
    // Re-sign it as a Supabase path; only fall back to the raw value if it's already an http(s) URL.
    if (!upstreamUrl && message.media_url) {
      if (/^https?:\/\//i.test(message.media_url)) {
        upstreamUrl = message.media_url;
      } else {
        try {
          upstreamUrl = await this.media.getSignedUrl(message.media_url, 60 * 60);
        } catch (err) {
          this.logger.warn(
            `Re-sign failed for ${message.media_url}: ${(err as Error).message}`,
          );
        }
      }
    }
    if (!upstreamUrl) throw new NotFoundException('Midia nao disponivel');

    try {
      const response = await firstValueFrom(
        this.http.get(upstreamUrl, { responseType: 'stream' }),
      );
      return {
        stream: response.data as NodeJS.ReadableStream,
        contentType:
          (response.headers['content-type'] as string | undefined) ??
          message.media_mimetype ??
          'application/octet-stream',
        contentLength: response.headers['content-length']
          ? Number(response.headers['content-length'])
          : message.media_size_bytes ?? undefined,
      };
    } catch (err) {
      this.logger.error(`Fetch upstream media failed: ${(err as Error).message}`);
      throw new BadGatewayException('Falha ao obter midia');
    }
  }

  async getHistory(leadId: string, user: AuthUser, cursor?: string, limit = 50) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    const rows = await this.prisma.message.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages,
      nextCursor: hasMore ? messages[messages.length - 1].id : undefined,
    };
  }
}
