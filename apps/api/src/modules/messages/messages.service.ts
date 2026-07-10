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
import { MessageType, SenderType, Prisma } from '@prisma/client';
import { UserRole } from '@/common/types/roles';
import { MESSAGES_SEND_QUEUE, SendMessageJobData } from './messages.queue';
import { OutboundWebhooksService } from '../outbound-webhooks/outbound-webhooks.service';
import { PushService } from '../push/push.service';

/**
 * F-03 — Opções de envio. senderType decide quem enviou (default 'user', o
 * caminho do app/web humano). Os controllers humanos não passam nada → 'user';
 * a API pública passa 'ai' (key is_ai) ou 'system'; a automação passa 'system'.
 * Só 'user' bloqueia a IA na conversa (ai_blocked=true).
 */
export interface SendOptions {
  senderType?: SenderType;
}

const sendTextSchema = z.object({
  lead_id: z.string().uuid(),
  content: z.string().min(1),
});

const internalNoteSchema = z.object({
  lead_id: z.string().uuid(),
  content: z.string().min(1),
  // @menções: ids de usuários do MESMO tenant a notificar (sino + push).
  mentioned_user_ids: z.array(z.string().uuid()).max(20).optional(),
});

interface InstanceConfig {
  uazapi_token?: string;
  uazapi_id?: string;
  /** Gateway de WhatsApp da instância. Ausente = 'uazapi' (retrocompatível). */
  provider?: 'uazapi' | 'evolution';
  /** Evolution: apikey/hash da instância (header `apikey`). */
  evolution_token?: string;
  /** Evolution: override opcional do servidor; default = EVOLUTION_BASE_URL. */
  evolution_base_url?: string;
  [key: string]: unknown;
}

/** Dados de transporte resolvidos a partir do config da instância. */
type Transport =
  | { provider: 'uazapi'; instanceName: string; baseUrl: string; token: string }
  | { provider: 'evolution'; instanceName: string; baseUrl: string; apiKey: string };

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
  private readonly evoBaseUrl: string;

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
    private outboundWebhooks: OutboundWebhooksService,
    private push: PushService,
  ) {
    this.baseUrl = this.config.get<string>('UAZAPI_BASE_URL', 'https://jgtech.uazapi.com');
    this.evoBaseUrl = this.config.get<string>('EVOLUTION_BASE_URL', '');
  }

  /**
   * Resolve o transporte (gateway) a partir do config da instância. provider
   * ausente = UazAPI (retrocompatível). Lança se faltar o token do provider.
   */
  private resolveTransport(instance: { nome: string; config: unknown }): Transport {
    const cfg = (instance.config ?? {}) as InstanceConfig;
    if (cfg.provider === 'evolution') {
      const apiKey = cfg.evolution_token;
      if (!apiKey) throw new NotFoundException('Token Evolution ausente para a instancia');
      const baseUrl = cfg.evolution_base_url || this.evoBaseUrl;
      if (!baseUrl) throw new NotFoundException('EVOLUTION_BASE_URL não configurado');
      return { provider: 'evolution', instanceName: instance.nome, baseUrl, apiKey };
    }
    const token = cfg.uazapi_token;
    if (!token) throw new NotFoundException('Token UazAPI ausente para a instancia');
    return { provider: 'uazapi', instanceName: instance.nome, baseUrl: this.baseUrl, token };
  }

  /** Campos do job específicos do provider (espalhados no payload da fila). */
  private jobTransport(t: Transport): Pick<
    SendMessageJobData,
    'provider' | 'uazBaseUrl' | 'uazToken' | 'evoBaseUrl' | 'evoApiKey'
  > {
    return t.provider === 'evolution'
      ? { provider: 'evolution', evoBaseUrl: t.baseUrl, evoApiKey: t.apiKey }
      : { provider: 'uazapi', uazBaseUrl: t.baseUrl, uazToken: t.token };
  }

  private emitMsgWebhook(args: {
    tenantId: string;
    messageId: string;
    leadId: string;
    text: string | null;
    type: string;
    direction: 'inbound' | 'outbound';
  }) {
    this.outboundWebhooks.dispatchMessageCreated({
      tenantId: args.tenantId,
      messageId: args.messageId,
      leadId: args.leadId,
      text: args.text,
      channel: 'whatsapp',
      direction: args.direction,
      type: args.type,
    }).catch(err => this.logger.warn(`dispatch message.created: ${String(err)}`));
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
      // Modo Individual: prefere instância do lead se for do user E estiver viva.
      const ofLead = instanceOfLead && instanceOfLead.owner_user_id === user.id
        ? instanceOfLead
        : null;
      instance = ofLead && liveStatuses.includes(ofLead.status) ? ofLead : null;
      // Auto-swap: instância do lead morta/ausente — cai pra uma instância viva
      // do user. Responsável faz swap; gerente/super-admin também (já passaram
      // o gate de acesso acima).
      const canSwap = lead.responsavel_id === user.id
        || user.role === UserRole.GERENTE
        || user.role === UserRole.SUPER_ADMIN;
      if (!instance && canSwap) {
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
    const transport = this.resolveTransport(instance);
    return { lead, transport, instanceName: transport.instanceName };
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

  async sendText(data: unknown, user: AuthUser, opts: SendOptions = {}) {
    const { lead_id, content } = sendTextSchema.parse(data);
    const { lead, transport, instanceName } = await this.resolveLeadAndToken(lead_id, user);

    // F-03: sender_type decidido no backend. Default 'user' (envio humano).
    const senderType: SenderType = opts.senderType ?? 'user';
    const senderId = senderType === 'user' ? user.id : null;

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
        sender_type: senderType,
        sender_id: senderId,
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });
    this.emitMsgWebhook({
      tenantId: user.tenantId, messageId: message.id, leadId: lead_id,
      text: outboundContent, type: 'TEXT', direction: 'outbound',
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
    // F-03: humano enviou → trava a IA na conversa.
    if (senderType === 'user') cadenceUpdate.ai_blocked = true;
    await this.prisma.lead.update({ where: { id: lead_id }, data: cadenceUpdate });

    // Board atualizado ao vivo via WebSocket (setQueryData no front). O delPattern
    // por-envio era redundante e fazia SCAN no Redis a cada msg → removido.
    this.gateway.emitNewMessage(lead_id, message, user.tenantId);

    await this.sendQueue.add('send-text', {
      kind: 'text',
      messageId: localId,
      leadId: lead_id,
      tenantId: user.tenantId,
      instanceName,
      telefone: lead.telefone,
      ...this.jobTransport(transport),
      content: outboundContent,
    });

    return message;
  }

  async createInternalNote(data: unknown, user: AuthUser) {
    const { lead_id, content, mentioned_user_ids } = internalNoteSchema.parse(data);
    if (user.role === UserRole.VISUALIZADOR) {
      throw new ForbiddenException('Visualizador nao pode criar notas');
    }
    const lead = await this.prisma.lead.findFirst({
      where: { id: lead_id, tenant_id: user.tenantId },
      select: { id: true, nome: true, responsavel_id: true, instancia_whatsapp: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (user.role === UserRole.OPERADOR && lead.responsavel_id !== user.id) {
      throw new ForbiddenException(
        lead.responsavel_id === null
          ? 'Lead disponivel no escritorio — assuma para responder'
          : 'Sem acesso a este lead',
      );
    }

    // Só usuários ativos do MESMO tenant podem ser mencionados; o autor não
    // se auto-notifica.
    const mentionTargets = mentioned_user_ids?.length
      ? await this.prisma.user.findMany({
          where: {
            id: { in: mentioned_user_ids, not: user.id },
            tenant_id: user.tenantId,
            ativo: true,
          },
          select: { id: true },
        })
      : [];

    const message = await this.prisma.message.create({
      data: {
        lead_id,
        instance_name: 'internal',
        whatsapp_message_id: uuid(),
        direction: 'OUTGOING',
        type: 'TEXT',
        content,
        status: 'READ',
        is_internal_note: true,
        // Nota interna não vai ao cliente nem bloqueia a IA → 'system'.
        sender_type: 'system',
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
        ...(mentionTargets.length
          ? { metadata: { mentions: mentionTargets.map((t) => t.id) } }
          : {}),
      },
    });

    if (mentionTargets.length) {
      const preview = content.length > 120 ? `${content.slice(0, 117)}...` : content;
      for (const target of mentionTargets) {
        const notif = await this.prisma.notification.create({
          data: {
            user_id: target.id,
            titulo: `${user.nome} mencionou você`,
            conteudo: `Nota em ${lead.nome}: "${preview}"`,
            tipo: 'mention',
            link: `/chat/${lead_id}`,
            tenant_id: user.tenantId,
          },
        });
        this.gateway.emitNotification(target.id, notif);
      }
      void this.push.sendToUsers(
        mentionTargets.map((t) => t.id),
        {
          title: `${user.nome} mencionou você`,
          body: `${lead.nome}: ${preview}`,
          url: `/chat/${lead_id}`,
          tag: `mention-${message.id}`,
        },
      );
    }

    return message;
  }

  async sendAudio(file: Express.Multer.File, body: unknown, user: AuthUser, opts: SendOptions = {}) {
    const { lead_id } = z.object({ lead_id: z.string().uuid() }).parse(body);
    if (!file) throw new NotFoundException('Arquivo de audio ausente');

    const { lead, transport, instanceName } = await this.resolveLeadAndToken(lead_id, user);
    const senderType: SenderType = opts.senderType ?? 'user';
    const senderId = senderType === 'user' ? user.id : null;

    const opusBuffer = await this.audio.convertToOpus(file.buffer, file.mimetype);
    const probedDuration = await this.audio.probeDurationSeconds(opusBuffer, 'audio/ogg');

    const filename = `audio/${lead_id}/${uuid()}.ogg`;
    await this.media.upload(filename, opusBuffer, 'audio/ogg; codecs=opus');
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
        media_mimetype: 'audio/ogg; codecs=opus',
        media_size_bytes: opusBuffer.length,
        media_duration_seconds: probedDuration,
        status: 'PENDING',
        sender_type: senderType,
        sender_id: senderId,
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });
    this.emitMsgWebhook({
      tenantId: user.tenantId, messageId: message.id, leadId: lead_id,
      text: null, type: 'AUDIO', direction: 'outbound',
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: {
        ultima_interacao: new Date(),
        last_agent_message_at: new Date(),
        ...(senderType === 'user' ? { ai_blocked: true } : {}),
      },
    });

    // Emit with signed URL so the frontend can render media immediately.
    // Board freshness é ao vivo via WebSocket; delPattern por-envio removido
    // (era redundante + SCAN no Redis a cada msg).
    this.gateway.emitNewMessage(lead_id, { ...message, media_url: signedUrl }, user.tenantId);

    await this.sendQueue.add('send-audio', {
      kind: 'audio',
      messageId: message.id,
      leadId: lead_id,
      tenantId: user.tenantId,
      instanceName,
      telefone: lead.telefone,
      ...this.jobTransport(transport),
      storagePath: filename,
      signedUrl,
      durationSeconds: probedDuration,
    });

    return { ...message, media_url: signedUrl };
  }

  async sendMedia(file: Express.Multer.File, body: unknown, user: AuthUser, opts: SendOptions = {}) {
    const { lead_id, caption } = z
      .object({
        lead_id: z.string().uuid(),
        caption: z.string().optional(),
      })
      .parse(body);
    if (!file) throw new NotFoundException('Arquivo ausente');

    const { lead, transport, instanceName } = await this.resolveLeadAndToken(lead_id, user);
    const senderType: SenderType = opts.senderType ?? 'user';
    const senderId = senderType === 'user' ? user.id : null;

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
        sender_type: senderType,
        sender_id: senderId,
        sent_by_user_id: user.id,
        visible_to_user_id: lead.responsavel_id === user.id ? lead.responsavel_id : null,
        tenant_id: user.tenantId,
      },
    });
    this.emitMsgWebhook({
      tenantId: user.tenantId, messageId: message.id, leadId: lead_id,
      text: outboundCaption ?? null, type: String(msgType), direction: 'outbound',
    });

    await this.prisma.lead.update({
      where: { id: lead_id },
      data: {
        ultima_interacao: new Date(),
        last_agent_message_at: new Date(),
        ...(senderType === 'user' ? { ai_blocked: true } : {}),
      },
    });

    // Emit with signed URL so the frontend can render media immediately.
    // Board freshness é ao vivo via WebSocket; delPattern por-envio removido
    // (era redundante + SCAN no Redis a cada msg).
    this.gateway.emitNewMessage(lead_id, { ...message, media_url: signedUrl }, user.tenantId);

    await this.sendQueue.add('send-media', {
      kind: 'media',
      messageId: message.id,
      leadId: lead_id,
      tenantId: user.tenantId,
      instanceName,
      telefone: lead.telefone,
      ...this.jobTransport(transport),
      storagePath,
      signedUrl,
      mimetype: processed.mimetype,
      mediaType: uazMediaType,
      caption: outboundCaption,
      filename: file.originalname,
    });

    return { ...message, media_url: signedUrl };
  }

  /**
   * Reenfileira uma mensagem de saída que falhou (status FAILED, sem
   * whatsapp_message_id). Reutiliza a MESMA linha de Message — não cria outra —
   * então o histórico/ordem da conversa não muda. Usado por:
   *   - botão "Reenviar" do atendente (ctx.user → checa permissão)
   *   - varredura automática de recuperação (ctx.system → resolve instância viva)
   *
   * Idempotência: se a msg já saiu (tem wamid ou status SENT), aborta sem
   * reenviar. O guard alreadySent() do processor é a segunda barreira.
   */
  async resend(messageId: string, ctx: { user?: AuthUser } = {}): Promise<{ id: string; status: string }> {
    const msg = await this.prisma.message.findUnique({ where: { id: messageId } });
    if (!msg) throw new NotFoundException('Mensagem nao encontrada');
    if (msg.direction !== 'OUTGOING' || msg.is_internal_note) {
      throw new ForbiddenException('Apenas mensagens de saida podem ser reenviadas');
    }
    if (msg.whatsapp_message_id || msg.status === 'SENT') {
      return { id: msg.id, status: 'already_sent' };
    }

    // Resolve instância + token. Manual: valida permissão do usuário; sistema:
    // pega a instância viva do tenant (lead pode ter trocado de instância).
    let transport: Transport;
    let telefone: string;
    if (ctx.user) {
      const r = await this.resolveLeadAndToken(msg.lead_id, ctx.user);
      transport = r.transport;
      telefone = r.lead.telefone;
    } else {
      const lead = await this.prisma.lead.findFirst({
        where: { id: msg.lead_id, tenant_id: msg.tenant_id },
        select: { telefone: true, instancia_whatsapp: true },
      });
      if (!lead) throw new NotFoundException('Lead nao encontrado');
      transport = await this.resolveSystemSendContext(msg.tenant_id, lead.instancia_whatsapp);
      telefone = lead.telefone;
    }
    const instanceName = transport.instanceName;

    // Marca PENDING e incrementa o contador de reenvios (lido pela varredura).
    const prevMeta = (msg.metadata && typeof msg.metadata === 'object')
      ? (msg.metadata as Record<string, unknown>)
      : {};
    const resendCount = (typeof prevMeta.resend_count === 'number' ? prevMeta.resend_count : 0) + 1;
    await this.prisma.message.update({
      where: { id: msg.id },
      data: {
        status: 'PENDING',
        metadata: { ...prevMeta, resend_count: resendCount, last_resend_at: new Date().toISOString() } as Prisma.InputJsonValue,
      },
    });

    // Re-enfileira o job do tipo correto, reconstruindo o payload da própria row.
    if (msg.type === MessageType.TEXT) {
      await this.sendQueue.add('send-text', {
        kind: 'text', messageId: msg.id, leadId: msg.lead_id, tenantId: msg.tenant_id,
        instanceName, telefone, ...this.jobTransport(transport),
        content: msg.content ?? '',
      });
    } else if (msg.type === MessageType.AUDIO) {
      const storagePath = msg.media_url ?? '';
      const signedUrl = await this.media.getSignedUrl(storagePath, 3600);
      await this.sendQueue.add('send-audio', {
        kind: 'audio', messageId: msg.id, leadId: msg.lead_id, tenantId: msg.tenant_id,
        instanceName, telefone, ...this.jobTransport(transport),
        storagePath, signedUrl, durationSeconds: msg.media_duration_seconds ?? undefined,
      });
    } else {
      const storagePath = msg.media_url ?? '';
      const signedUrl = await this.media.getSignedUrl(storagePath, 3600);
      const mediaType: MediaKind =
        msg.type === MessageType.IMAGE ? 'image'
        : msg.type === MessageType.VIDEO ? 'video'
        : 'document';
      await this.sendQueue.add('send-media', {
        kind: 'media', messageId: msg.id, leadId: msg.lead_id, tenantId: msg.tenant_id,
        instanceName, telefone, ...this.jobTransport(transport),
        storagePath, signedUrl, mimetype: msg.media_mimetype ?? 'application/octet-stream',
        mediaType, caption: msg.content ?? undefined, filename: msg.media_filename ?? undefined,
      });
    }

    this.gateway.emitMessageStatusUpdate(msg.lead_id, msg.id, 'PENDING');
    return { id: msg.id, status: 'PENDING' };
  }

  /**
   * Resolve instância viva + token p/ reenvio em modo sistema (sem usuário).
   * Prefere a instância atual do lead; se offline/ausente, cai em qualquer
   * instância ativa do tenant (modo compartilhado).
   */
  private async resolveSystemSendContext(
    tenantId: string,
    leadInstanceName: string | null,
  ): Promise<Transport> {
    const liveStatuses = ['open', 'connected', 'connecting'];
    let instance = leadInstanceName
      ? await this.prisma.whatsappInstance.findFirst({ where: { nome: leadInstanceName, tenant_id: tenantId } })
      : null;
    if (!instance || !liveStatuses.includes(instance.status)) {
      instance = await this.prisma.whatsappInstance.findFirst({
        where: { tenant_id: tenantId, status: { in: liveStatuses } },
        orderBy: [{ ultimo_check: 'desc' }, { created_at: 'desc' }],
      });
    }
    if (!instance || !liveStatuses.includes(instance.status)) {
      throw new NotFoundException('Nenhuma instancia WhatsApp conectada para reenvio');
    }
    return this.resolveTransport(instance);
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

    const isResponsavel = lead.responsavel_id === user.id;
    let ownedInstances: string[] = [];
    if (user.role === UserRole.OPERADOR) {
      ownedInstances = (
        await this.prisma.whatsappInstance.findMany({
          where: { owner_user_id: user.id, tenant_id: user.tenantId },
          select: { nome: true },
        })
      ).map((r) => r.nome);
      const accessible =
        isResponsavel ||
        (lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp));
      if (!accessible) {
        return { messages: [], nextCursor: undefined };
      }
    }
    // Gerente, SuperAdmin: passam direto, veem todas as mensagens do lead.

    // Dono do lead vê a conversa inteira (todos os números). Filtro por
    // instância só pra operador que acessa via número próprio sem ser o dono.
    const messagesFilter =
      user.role === UserRole.OPERADOR && !isResponsavel && ownedInstances.length
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
