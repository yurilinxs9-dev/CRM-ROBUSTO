import { BadGatewayException, ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { AudioService } from '../media/audio.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { MediaPipelineService } from '../media/media-pipeline.service';
import type { AuthUser } from '../../common/types/auth-user';
import { firstValueFrom } from 'rxjs';
import { v4 as uuid } from 'uuid';
import { z } from 'zod';
import { MessageType } from '@prisma/client';
import { UserRole } from '@/common/types/roles';
import { MESSAGES_SEND_QUEUE, SendMessageJobData } from './messages.queue';

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

type MediaKind = 'image' | 'video' | 'audio' | 'document';

function kindToMessageType(kind: MediaKind): MessageType {
  switch (kind) {
    case 'image':    return MessageType.IMAGE;
    case 'video':    return MessageType.VIDEO;
    case 'audio':    return MessageType.AUDIO;
    case 'document': return MessageType.DOCUMENT;
  }
}

function mimeToExt(mimetype: string): string {
  const map: Record<string, string> = {
    'image/webp':       'webp',
    'image/jpeg':       'jpg',
    'image/png':        'png',
    'image/gif':        'gif',
    'video/mp4':        'mp4',
    'video/webm':       'webm',
    'video/quicktime':  'mov',
    'audio/ogg':        'ogg',
    'audio/mpeg':       'mp3',
    'audio/mp4':        'm4a',
    'audio/wav':        'wav',
    'application/pdf':  'pdf',
  };
  return map[mimetype] ?? mimetype.split('/')[1]?.split(';')[0] ?? 'bin';
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
    private mediaPipeline: MediaPipelineService,
    @InjectQueue(MESSAGES_SEND_QUEUE) private readonly sendQueue: Queue<SendMessageJobData>,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
  }

  private async resolveLeadAndToken(leadId: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // Visualizador: nunca envia mensagens.
    if (user.role === UserRole.VISUALIZADOR) {
      throw new ForbiddenException('Visualizador nao pode enviar mensagens');
    }
    // is_private: somente o responsável pode enviar (gerente/super-admin
    // tambem nao bisbilhotam lead privado de outro gestor).
    if (lead.is_private && lead.responsavel_id !== user.id) {
      throw new ForbiddenException('Lead privado');
    }
    // Operador: precisa ser responsavel OU dono da instancia do lead.
    if (user.role === UserRole.OPERADOR) {
      const ownedInstances = (
        await this.prisma.whatsappInstance.findMany({
          where: { owner_user_id: user.id, tenant_id: user.tenantId },
          select: { nome: true },
        })
      ).map((r) => r.nome);
      const accessible =
        lead.responsavel_id === user.id ||
        (lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp));
      if (!accessible) {
        throw new ForbiddenException(
          lead.responsavel_id === null
            ? 'Lead disponivel no escritorio — assuma para responder'
            : 'Sem acesso a este lead',
        );
      }
    }
    // Gerente, SuperAdmin: passam direto.

    // Privacidade por instância MUDA conforme o modo:
    //  - Compartilhado (pool_enabled=true): instância é da equipe; qualquer
    //    user com acesso ao lead pode enviar pela instância dele.
    //  - Individual (pool_enabled=false): só envia pela própria instância;
    //    se o lead aponta pra instância de outro user, faz auto-swap pra
    //    a instância own ativa.
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { pool_enabled: true },
    });
    const liveStatuses = ['open', 'connected', 'connecting'];
    const instanceOfLead = await this.prisma.whatsappInstance.findFirst({
      where: { nome: lead.instancia_whatsapp, tenant_id: user.tenantId },
    });

    let instance: typeof instanceOfLead = null;
    if (tenant?.pool_enabled) {
      // Modo Compartilhado: prefere a instância do lead, mas se ela não
      // existe (lead criado manualmente sem instance ou instance removida),
      // cai pra qualquer instância ativa do tenant — o número é único da
      // equipe, qualquer um serve.
      instance = instanceOfLead ?? null;
      if (!instance || !liveStatuses.includes(instance.status)) {
        const fallback = await this.prisma.whatsappInstance.findFirst({
          where: { tenant_id: user.tenantId, status: { in: liveStatuses } },
          orderBy: [{ ultimo_check: 'desc' }, { created_at: 'desc' }],
        });
        if (fallback) {
          instance = fallback;
          if (lead.instancia_whatsapp !== fallback.nome) {
            await this.prisma.lead
              .update({ where: { id: lead.id }, data: { instancia_whatsapp: fallback.nome } })
              .catch(() => undefined);
            lead.instancia_whatsapp = fallback.nome;
          }
        }
      }
    } else {
      // Modo Individual: prefere instância do lead se for do user.
      instance = instanceOfLead && instanceOfLead.owner_user_id === user.id
        ? instanceOfLead
        : null;
      // Auto-swap: user é responsável mas instância do lead não é dele.
      if (!instance && lead.responsavel_id === user.id) {
        const own = await this.prisma.whatsappInstance.findFirst({
          where: {
            tenant_id: user.tenantId,
            owner_user_id: user.id,
            status: { in: liveStatuses },
          },
          orderBy: [{ ultimo_check: 'desc' }, { created_at: 'desc' }],
        });
        if (own) {
          instance = own;
          if (lead.instancia_whatsapp !== own.nome) {
            await this.prisma.lead
              .update({ where: { id: lead.id }, data: { instancia_whatsapp: own.nome } })
              .catch(() => undefined);
            lead.instancia_whatsapp = own.nome;
          }
        }
      }
    }

    if (!instance) {
      throw new ForbiddenException(
        tenant?.pool_enabled
          ? 'Lead não tem instância vinculada — peça pro super-admin conectar o número compartilhado.'
          : 'Sem permissão para enviar — instância pertence a outro usuário ou você ainda não conectou a sua',
      );
    }
    if (!liveStatuses.includes(instance.status)) {
      throw new NotFoundException('Sua instância WhatsApp não está conectada');
    }
    const cfg = (instance.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException('Token UazAPI ausente para a instancia');
    return { lead, token, instanceName: instance.nome };
  }

  private async buildOutboundPrefix(
    tenantId: string,
    userId: string,
    hasResponsavel: boolean,
  ): Promise<string> {
    if (!hasResponsavel) return '';
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { pool_enabled: true, prefix_enabled: true },
    });
    if (!tenant?.pool_enabled) return '';
    if (tenant.prefix_enabled === false) return '';
    const u = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { nome: true, titulo: true, especialidade: true },
    });
    if (!u) return '';
    const titulo = u.titulo ?? null;
    const especialidade = u.especialidade ?? null;
    const namePart = titulo ? `${titulo} ${u.nome}` : u.nome;
    const label = especialidade ? `${namePart} — ${especialidade}` : namePart;
    return `*${label}*\n\n`;
  }

  async sendText(data: unknown, user: AuthUser) {
    const { lead_id, content } = sendTextSchema.parse(data);
    const { lead, token, instanceName } = await this.resolveLeadAndToken(lead_id, user);

    const prefix = await this.buildOutboundPrefix(
      user.tenantId,
      user.id,
      lead.responsavel_id !== null,
    );
    const outboundContent = prefix ? prefix + content : content;

    const localId = uuid();

    const message = await this.prisma.message.create({
      data: {
        id: localId,
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: null,
        direction: 'OUTGOING',
        type: 'TEXT',
        content: outboundContent,
        status: 'PENDING',
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });

    // Avançar cadência manual se houver follow-up pendente
    const cadenceUpdate: Record<string, unknown> = {
      ultima_interacao: new Date(),
      last_agent_message_at: new Date(),
    };
    if (lead.proximo_followup !== null) {
      cadenceUpdate.proximo_followup = null;
      cadenceUpdate.cadence_step_index = lead.cadence_step_index + 1;
    }
    await this.prisma.lead.update({ where: { id: lead_id }, data: cadenceUpdate });

    await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
    this.gateway.emitNewMessage(lead_id, message, user.tenantId);

    await this.sendQueue.add('send-text', {
      kind: 'text',
      messageId: localId,
      leadId: lead_id,
      tenantId: user.tenantId,
      instanceName,
      telefone: lead.telefone,
      uazBaseUrl: this.baseUrl,
      uazToken: token,
      content: outboundContent,
    });

    return message;
  }

  async createInternalNote(data: unknown, user: AuthUser) {
    const { lead_id, content } = internalNoteSchema.parse(data);
    if (user.role === UserRole.VISUALIZADOR) {
      throw new ForbiddenException('Visualizador nao pode criar notas');
    }
    const lead = await this.prisma.lead.findFirst({
      where: { id: lead_id, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (user.role === UserRole.OPERADOR && lead.responsavel_id !== user.id) {
      throw new ForbiddenException(
        lead.responsavel_id === null
          ? 'Lead disponivel no escritorio — assuma para responder'
          : 'Sem acesso a este lead',
      );
    }
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
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });
  }

  async sendAudio(file: Express.Multer.File, body: unknown, user: AuthUser) {
    const { lead_id } = z.object({ lead_id: z.string().uuid() }).parse(body);
    if (!file) throw new NotFoundException('Arquivo de audio ausente');

    const { lead, token, instanceName } = await this.resolveLeadAndToken(lead_id, user);

    const opusBuffer = await this.audio.convertToOpus(file.buffer, file.mimetype);
    const probedDuration = await this.audio.probeDurationSeconds(opusBuffer, 'audio/ogg');

    const filename = `audio/${lead_id}/${uuid()}.ogg`;
    await this.media.upload(filename, opusBuffer, 'audio/ogg');
    const signedUrl = await this.media.getSignedUrl(filename, 60 * 60 * 24 * 7);

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: null,
        direction: 'OUTGOING',
        type: MessageType.AUDIO,
        content: null,
        media_url: filename,
        media_mimetype: 'audio/ogg',
        media_size_bytes: opusBuffer.length,
        media_duration_seconds: probedDuration,
        status: 'PENDING',
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date(), last_agent_message_at: new Date() },
    });

    // Invalidate cache BEFORE emitting WS so client refetch hits a fresh list.
    // Emit with signed URL so the frontend can render media immediately.
    await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
    this.gateway.emitNewMessage(lead_id, { ...message, media_url: signedUrl }, user.tenantId);

    await this.sendQueue.add('send-audio', {
      kind: 'audio',
      messageId: message.id,
      leadId: lead_id,
      tenantId: user.tenantId,
      instanceName,
      telefone: lead.telefone,
      uazBaseUrl: this.baseUrl,
      uazToken: token,
      storagePath: filename,
      signedUrl,
      durationSeconds: probedDuration,
    });

    return { ...message, media_url: signedUrl };
  }

  async sendMedia(file: Express.Multer.File, body: unknown, user: AuthUser) {
    const { lead_id, caption } = z
      .object({
        lead_id: z.string().uuid(),
        caption: z.string().optional(),
      })
      .parse(body);
    if (!file) throw new NotFoundException('Arquivo ausente');

    const { lead, token, instanceName } = await this.resolveLeadAndToken(lead_id, user);

    let processed: Awaited<ReturnType<MediaPipelineService['processMultipart']>>;
    try {
      processed = await this.mediaPipeline.processMultipart(file.buffer, file.mimetype);
    } catch (err) {
      this.logger.error(`Media pipeline failed: ${(err as Error).message}`);
      throw new BadGatewayException('Falha ao processar midia');
    }

    const fileId = uuid();
    const ext = mimeToExt(processed.mimetype);
    const storagePath = `${processed.kind}/${lead_id}/${fileId}.${ext}`;

    await this.media.upload(storagePath, processed.buffer, processed.mimetype);

    let thumbnailPath: string | undefined;
    if (processed.thumbnail) {
      thumbnailPath = `${processed.kind}/${lead_id}/${fileId}${processed.thumbnail.path_suffix}`;
      await this.media.upload(thumbnailPath, processed.thumbnail.buffer, processed.thumbnail.mimetype);
    }

    let posterPath: string | undefined;
    if (processed.poster) {
      posterPath = `${processed.kind}/${lead_id}/${fileId}${processed.poster.path_suffix}`;
      await this.media.upload(posterPath, processed.poster.buffer, processed.poster.mimetype);
    }

    const signedUrl = await this.media.getSignedUrl(storagePath, 60 * 60 * 24 * 7);

    const msgType = kindToMessageType(processed.kind);
    const uazMediaType: 'image' | 'video' | 'audio' | 'document' = processed.kind === 'document' ? 'document' : processed.kind;

    const prefix = caption
      ? await this.buildOutboundPrefix(
          user.tenantId,
          user.id,
          lead.responsavel_id !== null,
        )
      : '';
    const outboundCaption = prefix && caption ? prefix + caption : (caption ?? undefined);

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: lead.instancia_whatsapp,
        whatsapp_message_id: null,
        direction: 'OUTGOING',
        type: msgType,
        content: outboundCaption ?? null,
        media_url: storagePath,
        media_mimetype: processed.mimetype,
        media_size_bytes: processed.size_bytes,
        media_duration_seconds: processed.duration_seconds ?? null,
        media_width: processed.width ?? null,
        media_height: processed.height ?? null,
        media_thumbnail_path: thumbnailPath ?? null,
        media_poster_path: posterPath ?? null,
        status: 'PENDING',
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: { ultima_interacao: new Date(), last_agent_message_at: new Date() },
    });

    // Invalidate cache BEFORE emitting WS so client refetch hits a fresh list.
    // Emit with signed URL so the frontend can render media immediately.
    await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
    this.gateway.emitNewMessage(lead_id, { ...message, media_url: signedUrl }, user.tenantId);

    await this.sendQueue.add('send-media', {
      kind: 'media',
      messageId: message.id,
      leadId: lead_id,
      tenantId: user.tenantId,
      instanceName,
      telefone: lead.telefone,
      uazBaseUrl: this.baseUrl,
      uazToken: token,
      storagePath,
      signedUrl,
      mimetype: processed.mimetype,
      mediaType: uazMediaType,
      caption: outboundCaption,
      filename: file.originalname,
    });

    return { ...message, media_url: signedUrl };
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
    // Both sendAudio/sendMedia (outgoing) and webhook.processor (incoming) store the
    // storage path in `media_url`. Try it first.
    if (message.media_url) {
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
    // Last-resort fallback: `media_filename` may hold a storage path on legacy rows.
    // Skip plain filenames (no slash) — those are original upload names, not paths.
    if (!upstreamUrl && message.media_filename && message.media_filename.includes('/')) {
      if (/^https?:\/\//i.test(message.media_filename)) {
        upstreamUrl = message.media_filename;
      } else {
        try {
          upstreamUrl = await this.media.getSignedUrl(message.media_filename, 60 * 60);
        } catch (err) {
          this.logger.warn(
            `Re-sign failed for ${message.media_filename}: ${(err as Error).message}`,
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
      select: { id: true, responsavel_id: true, instancia_whatsapp: true, is_private: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // Visualizador: nao acessa historico.
    if (user.role === UserRole.VISUALIZADOR) {
      return { messages: [], nextCursor: undefined };
    }
    // is_private blinda contra todos exceto responsavel.
    if (lead.is_private && lead.responsavel_id !== user.id) {
      return { messages: [], nextCursor: undefined };
    }

    let ownedInstances: string[] = [];
    if (user.role === UserRole.OPERADOR) {
      ownedInstances = (
        await this.prisma.whatsappInstance.findMany({
          where: { owner_user_id: user.id, tenant_id: user.tenantId },
          select: { nome: true },
        })
      ).map((r) => r.nome);
      const accessible =
        lead.responsavel_id === user.id ||
        (lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp));
      if (!accessible) {
        return { messages: [], nextCursor: undefined };
      }
    }
    // Gerente, SuperAdmin: passam direto, veem todas as mensagens do lead.

    const messagesFilter =
      user.role === UserRole.OPERADOR && ownedInstances.length
        ? { instance_name: { in: ownedInstances } }
        : {};

    const rows = await this.prisma.message.findMany({
      where: {
        lead_id: leadId,
        tenant_id: user.tenantId,
        ...messagesFilter,
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;

    // Sign Supabase storage paths so the frontend can load media directly.
    // For archived messages (media_url cleared by cleanup cron), sign the
    // surviving thumbnail/poster so the chat still renders a visual placeholder.
    const signed = await Promise.all(
      messages.map(async (msg) => {
        let result = msg as typeof msg & { media_thumbnail_url?: string | null };

        if (msg.media_archived && msg.media_thumbnail_path) {
          try {
            const thumbUrl = await this.media.getSignedUrl(msg.media_thumbnail_path, 60 * 60);
            result = { ...result, media_thumbnail_url: thumbUrl };
          } catch {
            // ignore — frontend falls back to "Mídia removida" placeholder.
          }
        }

        if (!msg.media_url || /^https?:\/\//i.test(msg.media_url)) return result;
        try {
          const signedUrl = await this.media.getSignedUrl(msg.media_url, 60 * 60);
          return { ...result, media_url: signedUrl };
        } catch {
          return result;
        }
      }),
    );

    return {
      messages: signed,
      nextCursor: hasMore ? messages[messages.length - 1].id : undefined,
    };
  }

  /**
   * Backfill missing messages for a lead by pulling history from UazAPI.
   * Re-downloads any media that did not arrive through the webhook (UazAPI
   * occasionally drops `messages` events for individual chats — see fix log).
   */
  async syncChat(leadId: string, user: AuthUser): Promise<{ added: number; mediaFixed: number }> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true, telefone: true, instancia_whatsapp: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    const instance = await this.prisma.whatsappInstance.findFirst({
      where: lead.instancia_whatsapp
        ? { nome: lead.instancia_whatsapp, tenant_id: user.tenantId }
        : { tenant_id: user.tenantId, status: { in: ['open', 'connected'] } },
      orderBy: { created_at: 'asc' },
    });
    if (!instance) throw new NotFoundException('Instancia ativa nao encontrada');

    const cfg = (instance.config as InstanceConfig | null) ?? {};
    const tok = cfg.uazapi_token;
    if (!tok) throw new BadGatewayException('Instancia sem uazapi_token');

    const chatid = `${lead.telefone}@s.whatsapp.net`;
    const findRes = await fetch(`${this.baseUrl}/message/find`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', token: tok },
      body: JSON.stringify({ chatid, limit: 50 }),
    });
    if (!findRes.ok) throw new BadGatewayException(`UazAPI find ${findRes.status}`);
    const findJson = (await findRes.json()) as { messages?: Array<Record<string, unknown>> };
    const remote = findJson.messages ?? [];

    const existing = await this.prisma.message.findMany({
      where: { lead_id: lead.id },
      select: { id: true, whatsapp_message_id: true, media_url: true, type: true },
    });
    const known = new Map(existing.map((m) => [m.whatsapp_message_id ?? '', m]));

    const typeMap: Record<string, MessageType> = {
      AudioMessage:        MessageType.AUDIO,
      ImageMessage:        MessageType.IMAGE,
      VideoMessage:        MessageType.VIDEO,
      DocumentMessage:     MessageType.DOCUMENT,
      StickerMessage:      MessageType.STICKER,
      ExtendedTextMessage: MessageType.TEXT,
      Conversation:        MessageType.TEXT,
    };
    const mediaTypes = new Set<MessageType>([MessageType.AUDIO, MessageType.IMAGE, MessageType.VIDEO, MessageType.DOCUMENT]);

    let added = 0;
    let mediaFixed = 0;
    for (const m of remote.slice().sort((a, b) => Number(a.messageTimestamp) - Number(b.messageTimestamp))) {
      const wid = m.messageid as string;
      const fromMe = Boolean(m.fromMe);
      const mtype = typeMap[m.messageType as string] ?? MessageType.TEXT;
      const content = m.content as Record<string, unknown> | string | undefined;
      const txt =
        typeof content === 'string'
          ? content
          : ((content as Record<string, unknown>)?.text as string | undefined) ?? '';
      const ts = m.messageTimestamp ? new Date(Number(m.messageTimestamp)) : new Date();

      const existingRow = known.get(wid);
      let messageId = existingRow?.id;

      if (!existingRow) {
        const created = await this.prisma.message.create({
          data: {
            lead_id: lead.id,
            tenant_id: user.tenantId,
            instance_name: instance.nome,
            whatsapp_message_id: wid,
            direction: fromMe ? 'OUTGOING' : 'INCOMING',
            type: mtype,
            content: txt || null,
            status: fromMe ? 'SENT' : 'DELIVERED',
            created_at: ts,
          },
          select: { id: true },
        });
        messageId = created.id;
        added++;
      }

      if (messageId && mediaTypes.has(mtype) && (!existingRow || !existingRow.media_url)) {
        try {
          const dlRes = await fetch(`${this.baseUrl}/message/download`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', token: tok },
            body: JSON.stringify({ id: wid }),
          });
          if (!dlRes.ok) continue;
          const dlInfo = (await dlRes.json()) as { fileURL?: string; mimetype?: string };
          if (!dlInfo.fileURL) continue;
          const buf = Buffer.from(await (await fetch(dlInfo.fileURL)).arrayBuffer());
          const ext = mimeToExt(dlInfo.mimetype ?? 'application/octet-stream');
          const kind: MediaKind =
            mtype === MessageType.AUDIO ? 'audio'
            : mtype === MessageType.IMAGE ? 'image'
            : mtype === MessageType.VIDEO ? 'video' : 'document';
          const path = `${user.tenantId}/${kind}/${messageId}.${ext}`;
          await this.media.upload(path, buf, dlInfo.mimetype ?? 'application/octet-stream');
          let waveform: number[] | null = null;
          const wfRaw = (content as Record<string, unknown>)?.waveform;
          if (typeof wfRaw === 'string') {
            try {
              waveform = Array.from(Buffer.from(wfRaw, 'base64')).slice(0, 64).map((x) => x / 255);
            } catch { /* ignore */ }
          }
          await this.prisma.message.update({
            where: { id: messageId },
            data: {
              media_url: path,
              media_mimetype: dlInfo.mimetype ?? null,
              media_size_bytes: buf.length,
              media_duration_seconds:
                typeof (content as Record<string, unknown>)?.seconds === 'number'
                  ? ((content as Record<string, unknown>).seconds as number)
                  : null,
              media_waveform_peaks: waveform ?? undefined,
            },
          });
          mediaFixed++;
        } catch (err) {
          this.logger.warn(`syncChat media fix failed for ${wid}: ${String(err)}`);
        }
      }
    }

    if (added > 0 || mediaFixed > 0) {
      await this.prisma.lead.update({
        where: { id: lead.id },
        data: { ultima_interacao: new Date() },
      });
      await this.cache.delPattern(`leads:list:${user.tenantId}:*`);
      this.gateway.emitMessageStatusUpdate(lead.id, 'sync', 'SYNCED');
    }

    return { added, mediaFixed };
  }
}
