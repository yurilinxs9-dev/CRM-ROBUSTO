import { BadGatewayException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { AudioService } from '../media/audio.service';
import { CrmGateway } from '../websocket/websocket.gateway';
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
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
  }

  async sendText(data: unknown, userId: string) {
    const { lead_id, content } = sendTextSchema.parse(data);

    const lead = await this.prisma.lead.findUnique({ where: { id: lead_id } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { nome: lead.instancia_whatsapp },
    });
    if (!instance) throw new NotFoundException('Instancia WhatsApp nao encontrada');
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException('Token UazAPI ausente para a instancia');

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
        sent_by_user_id: userId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    return message;
  }

  async createInternalNote(data: unknown, userId: string) {
    const { lead_id, content } = internalNoteSchema.parse(data);
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
        sent_by_user_id: userId,
      },
    });
  }

  private async resolveLeadAndToken(leadId: string) {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId } });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { nome: lead.instancia_whatsapp },
    });
    if (!instance) throw new NotFoundException('Instancia WhatsApp nao encontrada');
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException('Token UazAPI ausente para a instancia');
    return { lead, token };
  }

  private detectMediaType(mimetype: string): { type: MessageType; uazType: 'image' | 'video' | 'document' } {
    if (mimetype.startsWith('image/')) return { type: MessageType.IMAGE, uazType: 'image' };
    if (mimetype.startsWith('video/')) return { type: MessageType.VIDEO, uazType: 'video' };
    return { type: MessageType.DOCUMENT, uazType: 'document' };
  }

  async sendAudio(file: Express.Multer.File, body: unknown, userId: string) {
    const { lead_id } = z.object({ lead_id: z.string().uuid() }).parse(body);
    if (!file) throw new NotFoundException('Arquivo de audio ausente');

    const { lead, token } = await this.resolveLeadAndToken(lead_id);

    const opusBuffer = await this.audio.convertToOpus(file.buffer, file.mimetype);
    const filename = `audio/${lead_id}/${uuid()}.ogg`;
    await this.media.upload(filename, opusBuffer, 'audio/ogg');
    const signedUrl = await this.media.getSignedUrl(filename, 60 * 60 * 24 * 7);

    let response: Record<string, unknown>;
    try {
      const res = await firstValueFrom(
        this.http.post<Record<string, unknown>>(
          `${this.baseUrl}/send/media`,
          { number: lead.telefone, type: 'audio', ptt: true, file: signedUrl },
          { headers: { token } },
        ),
      );
      response = res.data;
    } catch (err) {
      this.logger.error(`UazAPI send audio failed: ${(err as Error).message}`);
      throw new BadGatewayException('Falha ao enviar audio via UazAPI');
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
        type: MessageType.AUDIO,
        content: null,
        media_url: signedUrl,
        media_mimetype: 'audio/ogg',
        media_filename: filename,
        media_size_bytes: opusBuffer.length,
        status: 'SENT',
        sent_by_user_id: userId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    this.gateway.emitNewMessage(lead_id, message);
    return message;
  }

  async sendMedia(file: Express.Multer.File, body: unknown, userId: string) {
    const { lead_id, caption } = z
      .object({ lead_id: z.string().uuid(), caption: z.string().optional() })
      .parse(body);
    if (!file) throw new NotFoundException('Arquivo ausente');

    const { lead, token } = await this.resolveLeadAndToken(lead_id);
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
        sent_by_user_id: userId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date() },
    });

    this.gateway.emitNewMessage(lead_id, message);
    return message;
  }

  async getHistory(leadId: string, cursor?: string, limit = 50) {
    return this.prisma.message.findMany({
      where: { lead_id: leadId },
      orderBy: { created_at: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }
}
