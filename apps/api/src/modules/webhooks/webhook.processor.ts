import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import type { MessageType, Prisma, WhatsappInstance } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { MediaService } from '../media/media.service';
import {
  type ExtractedMessage,
  extractFromEvolution,
  extractFromUazapi,
  extractFromWpp,
  synthesizeMessageId,
} from './message-extractor';

type Obj = Record<string, unknown>;

interface PipelineCtx {
  pipeline: { id: string };
  firstStage: { id: string };
}

interface SaveMessageInput {
  tenantId: string;
  instance: WhatsappInstance;
  phone: string;
  pushName?: string;
  messageId: string | undefined;
  isFromMe: boolean;
  extracted: ExtractedMessage;
  rawPayload: Obj;
}

@Processor('webhooks', { concurrency: 3 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private prisma: PrismaService,
    private leadsService: LeadsService,
    private gateway: CrmGateway,
    private mediaService: MediaService,
  ) {
    super();
  }

  async process(job: Job) {
    const start = Date.now();
    try {
      switch (job.name) {
        case 'onmessage':
          await this.handleWppMessage(job.data);
          break;
        case 'status-find':
          await this.handleWppStatus(job.data);
          break;
        case 'messages.upsert':
          await this.handleMessageUpsert(job.data);
          break;
        case 'messages.update':
          await this.handleMessageUpdate(job.data);
          break;
        case 'connection.update':
          await this.handleConnectionUpdate(job.data);
          break;
        case 'contacts.upsert':
          await this.handleContactsUpsert(job.data);
          break;
        case 'uazapi.messages':
        case 'uazapi.message':
          await this.handleUazapiMessage(job.data);
          break;
        case 'uazapi.messages_update':
        case 'uazapi.message_ack':
          await this.handleUazapiMessageAck(job.data);
          break;
        case 'uazapi.connection':
        case 'uazapi.connection_update':
          await this.handleUazapiConnectionUpdate(job.data);
          break;
        default:
          this.logger.warn(`Evento nao suportado: ${job.name}`);
      }

      const processingTime = Date.now() - start;
      await this.prisma.webhookLog.updateMany({
        where: { event: job.name, processed: false },
        data: { processed: true, processing_time_ms: processingTime },
      });
    } catch (error) {
      this.logger.error(`Erro no webhook ${job.name}:`, error);
      await this.prisma.webhookLog.updateMany({
        where: { event: job.name, processed: false },
        data: { error: String(error) },
      });
      throw error;
    }
  }

  // ── Helpers ─────────────────────────────────────────────────────────────────

  private async findInstanceByName(name: string | undefined) {
    if (!name) return null;
    return this.prisma.whatsappInstance.findFirst({ where: { nome: name } });
  }

  private async findInstanceByUazapiToken(token: string | undefined) {
    if (!token) return null;
    return this.prisma.whatsappInstance.findFirst({
      where: { config: { path: ['uazapi_token'], equals: token } },
    });
  }

  /**
   * Ensures the tenant has at least one active pipeline + first stage.
   * Auto-creates a default pipeline "Principal" with stages "Novo / Em Atendimento / Ganho / Perdido"
   * if none exists — prevents silently dropping incoming messages.
   */
  private async ensurePipelineAndStage(tenantId: string): Promise<PipelineCtx | null> {
    let pipeline = await this.prisma.pipeline.findFirst({
      where: { ativo: true, tenant_id: tenantId },
      orderBy: { created_at: 'asc' },
    });

    if (!pipeline) {
      this.logger.warn(`Nenhum pipeline para tenant ${tenantId}, criando default`);
      pipeline = await this.prisma.pipeline.create({
        data: {
          nome: 'Principal',
          descricao: 'Pipeline criado automaticamente',
          ativo: true,
          tenant_id: tenantId,
          stages: {
            create: [
              { nome: 'Novo', ordem: 0, cor: '#38bdf8', tenant_id: tenantId },
              { nome: 'Em Atendimento', ordem: 1, cor: '#fb923c', tenant_id: tenantId },
              { nome: 'Ganho', ordem: 2, cor: '#22c55e', is_won: true, tenant_id: tenantId },
              { nome: 'Perdido', ordem: 3, cor: '#ef4444', is_lost: true, tenant_id: tenantId },
            ],
          },
        },
      });
    }

    const firstStage = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipeline.id, tenant_id: tenantId },
      orderBy: { ordem: 'asc' },
    });
    if (!firstStage) {
      this.logger.error(`Pipeline ${pipeline.id} sem stages — inconsistencia`);
      return null;
    }
    return { pipeline, firstStage };
  }

  /**
   * Downloads remote media to a buffer. Returns null on failure without throwing.
   */
  private async downloadMedia(url: string): Promise<Buffer | null> {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      if (!res.ok) {
        this.logger.warn(`Media download nao-OK: ${url} status=${res.status}`);
        return null;
      }
      const ab = await res.arrayBuffer();
      return Buffer.from(ab);
    } catch (err) {
      this.logger.warn(`Falha baixando media: ${url} — ${String(err)}`);
      return null;
    }
  }

  private extFromMime(mime: string | undefined, fallback: string): string {
    if (!mime) return fallback;
    const map: Record<string, string> = {
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp4': 'm4a',
      'audio/webm': 'webm',
      'application/pdf': 'pdf',
    };
    if (map[mime]) return map[mime];
    const subtype = mime.split('/')[1];
    return subtype?.split(';')[0] ?? fallback;
  }

  /**
   * Uploads extracted media to Supabase Storage and returns the storage path.
   * Returns undefined if no URL or download/upload fails.
   */
  private async storeMedia(
    extracted: ExtractedMessage,
    tenantId: string,
    messageId: string,
  ): Promise<string | undefined> {
    const url = extracted.media?.url;
    if (!url || !/^https?:\/\//i.test(url)) return undefined;

    const buf = await this.downloadMedia(url);
    if (!buf) return undefined;

    const mimetype = extracted.media?.mimetype ?? 'application/octet-stream';
    const ext = this.extFromMime(mimetype, 'bin');
    const folder = extracted.type.toLowerCase();
    const path = `${tenantId}/${folder}/${messageId}.${ext}`;

    try {
      await this.mediaService.upload(path, buf, mimetype);
      return path;
    } catch (err) {
      this.logger.warn(`Falha upload media ${path}: ${String(err)}`);
      return undefined;
    }
  }

  /**
   * Unified message persistence. Upserts lead, stores media if present, upserts message,
   * emits WebSocket event, and invalidates caches. Never silently drops.
   */
  private async saveIncomingMessage(input: SaveMessageInput): Promise<void> {
    const { tenantId, instance, phone, pushName, isFromMe, extracted, rawPayload } = input;
    let { messageId } = input;

    if (!phone) {
      this.logger.warn(`Mensagem sem phone válido — instance=${instance.nome}`);
      return;
    }

    const ctx = await this.ensurePipelineAndStage(tenantId);
    if (!ctx) {
      this.logger.error(`Sem pipeline/stage para tenant ${tenantId} — mensagem perdida`);
      return;
    }

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: ctx.pipeline.id } },
      create: {
        nome: pushName || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instance.nome,
        pipeline_id: ctx.pipeline.id,
        estagio_id: ctx.firstStage.id,
        responsavel_id: instance.owner_user_id,
        ultima_interacao: new Date(),
        tenant_id: tenantId,
      },
      update: {
        ultima_interacao: new Date(),
        mensagens_nao_lidas: { increment: isFromMe ? 0 : 1 },
      },
    });

    // Synthesize id when webhook omits it — never drop the message
    if (!messageId) {
      messageId = synthesizeMessageId(lead.id);
      this.logger.warn(
        `messageId ausente — gerado sintetico ${messageId} para lead ${lead.id}`,
      );
    }

    // Store media if present (non-blocking failure)
    const storagePath = await this.storeMedia(extracted, tenantId, messageId);

    const metadata: Prisma.InputJsonValue = {
      raw: JSON.parse(JSON.stringify(rawPayload)) as unknown as Prisma.InputJsonValue,
      ...(extracted.location ? { location: extracted.location } : {}),
      ...(extracted.contact ? { contact: extracted.contact } : {}),
    };

    const message = await this.prisma.message.upsert({
      where: { whatsapp_message_id: messageId },
      create: {
        lead_id: lead.id,
        instance_name: instance.nome,
        whatsapp_message_id: messageId,
        direction: isFromMe ? 'OUTGOING' : 'INCOMING',
        type: extracted.type as MessageType,
        content: extracted.content,
        media_url: storagePath,
        media_mimetype: extracted.media?.mimetype,
        media_duration_seconds: extracted.media?.duration_seconds,
        media_filename: extracted.media?.filename,
        media_size_bytes: extracted.media?.size_bytes,
        status: isFromMe ? 'SENT' : 'DELIVERED',
        metadata,
        tenant_id: tenantId,
      },
      update: {},
    });

    // Resolve a signed URL for realtime clients so images/audio/video render
    // immediately without a page refresh. DB keeps the bare storage path
    // (cheap to re-sign on demand via leads.getMessages / streamMedia).
    let realtimeMediaUrl: string | null = message.media_url;
    if (storagePath) {
      try {
        realtimeMediaUrl = await this.mediaService.getSignedUrl(
          storagePath,
          60 * 60,
        );
      } catch (err) {
        this.logger.warn(
          `Falha assinando media ${storagePath} para realtime: ${String(err)}`,
        );
      }
    }

    this.gateway.emitNewMessage(
      lead.id,
      { ...message, media_url: realtimeMediaUrl },
      tenantId,
    );
    if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);

    if (lead.nome === lead.telefone || !lead.foto_url) {
      void this.leadsService.syncProfileSafe(lead.id);
    }
  }

  // ── WPPConnect handlers ──────────────────────────────────────────────────────

  private async handleWppMessage(payload: Obj) {
    const instanceName = payload?.instance as string | undefined;
    const msg = payload?.data as Obj | undefined;
    if (!msg) {
      this.logger.warn('WPP payload sem data');
      return;
    }
    if (msg.isGroupMsg === true) return;

    const from = msg.from as string | undefined;
    if (!from) {
      this.logger.warn('WPP message sem from');
      return;
    }

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) {
      // Throw — triggers BullMQ retry (instance may be creating)
      throw new Error(`WPP instancia desconhecida: ${instanceName}`);
    }

    const phone = from.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const msgIdObj = msg.id as Obj | undefined;
    const messageId = (msgIdObj?._serialized as string) || (msg.id as string) || undefined;
    const isFromMe = (msg.fromMe as boolean) || false;
    const pushName = msg.pushName as string | undefined;

    const extracted = extractFromWpp(msg);

    await this.saveIncomingMessage({
      tenantId: instance.tenant_id,
      instance,
      phone,
      pushName,
      messageId,
      isFromMe,
      extracted,
      rawPayload: payload,
    });
  }

  private async handleWppStatus(payload: Obj) {
    const instanceName = payload?.instance as string | undefined;
    if (!instanceName) return;

    const rawStatus = payload?.data as string | undefined;
    const statusMap: Record<string, string> = {
      CONNECTED: 'open',
      QRCODE: 'connecting',
      DISCONNECTED: 'close',
      DESTROYED: 'close',
      notLogged: 'close',
    };
    const status = (rawStatus && statusMap[rawStatus]) || 'disconnected';

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) return;
    await this.prisma.whatsappInstance.update({
      where: { nome: instanceName },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instanceName, status, instance.tenant_id);
  }

  // ── Evolution API handlers ──────────────────────────────────────────────────

  private async handleMessageUpsert(data: Obj) {
    const rawData = data?.data as Obj | undefined;
    const msg = (rawData?.message || rawData) as Obj | undefined;
    if (!msg) {
      this.logger.warn('Evolution payload sem message');
      return;
    }

    const instanceName = data?.instance as string | undefined;
    const key = msg?.key as Obj | undefined;
    const remoteJid = key?.remoteJid as string | undefined;
    if (!remoteJid) {
      this.logger.warn('Evolution message sem remoteJid');
      return;
    }
    if (remoteJid.includes('@g.us')) return; // group

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) {
      throw new Error(`Evolution instancia desconhecida: ${instanceName}`);
    }

    const phone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const messageId = key?.id as string | undefined;
    const isFromMe = !!(key?.fromMe as boolean);
    const messageContent = msg?.message as Obj | undefined;
    const pushName = msg?.pushName as string | undefined;

    const extracted = extractFromEvolution(messageContent);

    await this.saveIncomingMessage({
      tenantId: instance.tenant_id,
      instance,
      phone,
      pushName,
      messageId,
      isFromMe,
      extracted,
      rawPayload: data,
    });
  }

  private async handleMessageUpdate(data: Obj) {
    const updates = data?.data as Array<Obj> | undefined;
    if (!Array.isArray(updates)) return;
    for (const update of updates) {
      const key = update?.key as Obj | undefined;
      const messageId = key?.id as string | undefined;
      const updateData = update?.update as Obj | undefined;
      const status = updateData?.status as string | undefined;
      if (!messageId || !status) continue;

      const statusMap: Record<string, string> = {
        DELIVERY_ACK: 'DELIVERED',
        READ: 'READ',
        PLAYED: 'READ',
        ERROR: 'FAILED',
      };
      const mappedStatus = statusMap[status];
      if (mappedStatus) {
        await this.prisma.message.updateMany({
          where: { whatsapp_message_id: messageId },
          data: { status: mappedStatus as 'DELIVERED' | 'READ' | 'FAILED' },
        });
      }
    }
  }

  private async handleConnectionUpdate(data: Obj) {
    const instanceName = data?.instance as string | undefined;
    const connectionData = data?.data as Obj | undefined;
    const state = connectionData?.state as string | undefined;
    if (!instanceName) return;

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) return;
    await this.prisma.whatsappInstance.update({
      where: { nome: instanceName },
      data: { status: state || 'disconnected', ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instanceName, state || 'disconnected', instance.tenant_id);
  }

  // ── UazAPI handlers ─────────────────────────────────────────────────────────

  private async handleUazapiMessage(payload: Obj) {
    const message = payload?.message as Obj | undefined;
    if (!message) {
      this.logger.warn('UazAPI payload sem message');
      return;
    }
    if (message.isGroup === true) return;

    const chatid = message.chatid as string | undefined;
    if (!chatid) {
      this.logger.warn('UazAPI message sem chatid');
      return;
    }

    const phone = chatid.split('@')[0].split(':')[0].replace(/\D/g, '');
    const messageId = (message.messageid as string | undefined) ?? (message.id as string | undefined);
    const isFromMe = !!(message.fromMe as boolean | undefined);
    const pushName =
      (message.senderName as string | undefined) ?? (message.pushName as string | undefined);

    const token = payload.token as string | undefined;
    const instance = await this.findInstanceByUazapiToken(token);
    if (!instance) {
      throw new Error(`UazAPI token desconhecido`);
    }

    const extracted = extractFromUazapi(message);

    await this.saveIncomingMessage({
      tenantId: instance.tenant_id,
      instance,
      phone,
      pushName,
      messageId,
      isFromMe,
      extracted,
      rawPayload: payload,
    });
  }

  private async handleUazapiMessageAck(payload: Obj) {
    const message = (payload?.message ?? payload?.data) as Obj | undefined;
    if (!message) return;

    const messageId =
      (message.messageid as string | undefined) ?? (message.id as string | undefined);
    if (!messageId) return;

    const rawStatus = message.status as string | number | undefined;
    const statusMap: Record<string, 'SENT' | 'DELIVERED' | 'READ'> = {
      SENT: 'SENT',
      DELIVERED: 'DELIVERED',
      SERVER_ACK: 'SENT',
      DELIVERY_ACK: 'DELIVERED',
      READ: 'READ',
      PLAYED: 'READ',
      '2': 'SENT',
      '3': 'DELIVERED',
      '4': 'READ',
    };
    const mapped = rawStatus !== undefined ? statusMap[String(rawStatus)] : undefined;
    if (!mapped) return;

    await this.prisma.message.updateMany({
      where: { whatsapp_message_id: messageId },
      data: { status: mapped },
    });
  }

  private async handleUazapiConnectionUpdate(payload: Obj) {
    const instanceField = payload?.instance as Obj | undefined;
    const data = payload?.data as Obj | undefined;
    const rawState =
      (instanceField?.status as string | undefined) ??
      (data?.state as string | undefined) ??
      (data?.status as string | undefined) ??
      'disconnected';
    const stateMap: Record<string, string> = {
      connected: 'open',
      open: 'open',
      connecting: 'connecting',
      disconnected: 'close',
      close: 'close',
    };
    const status = stateMap[rawState] ?? rawState;

    const token = payload.token as string | undefined;
    const instance = await this.findInstanceByUazapiToken(token);
    if (!instance) return;

    await this.prisma.whatsappInstance.update({
      where: { nome: instance.nome },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instance.nome, status, instance.tenant_id);
  }

  private async handleContactsUpsert(data: Obj) {
    const contacts = data?.data as Array<Obj> | undefined;
    if (!Array.isArray(contacts)) return;

    // SECURITY: scope updates to the instance's tenant. Without this, a contacts
    // webhook from one tenant would overwrite lead names/photos in all tenants
    // that happen to share the same phone number (cross-tenant data leakage
    // and the root cause of the "nomes iguais" bug seen in the chat list).
    const instanceName = data?.instance as string | undefined;
    const instance = await this.findInstanceByName(instanceName);
    if (!instance) {
      this.logger.warn(
        `contacts.upsert ignorado — instancia desconhecida: ${instanceName}`,
      );
      return;
    }

    for (const contact of contacts) {
      const contactId = contact?.id as string | undefined;
      const phone = contactId?.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (!phone) continue;

      const nome = (contact?.pushName || contact?.name || undefined) as
        | string
        | undefined;
      const foto_url = (contact?.profilePictureUrl || undefined) as
        | string
        | undefined;

      const updateData: { nome?: string; foto_url?: string } = {};
      // Only overwrite `nome` when the existing name is the bare phone digits
      // (i.e. placeholder). Never clobber a real human name already set.
      if (foto_url) updateData.foto_url = foto_url;
      if (Object.keys(updateData).length === 0 && !nome) continue;

      await this.prisma.lead.updateMany({
        where: {
          telefone: phone,
          tenant_id: instance.tenant_id,
          instancia_whatsapp: instance.nome,
        },
        data: updateData,
      });

      if (nome) {
        await this.prisma.lead.updateMany({
          where: {
            telefone: phone,
            tenant_id: instance.tenant_id,
            instancia_whatsapp: instance.nome,
            nome: phone, // only when still the placeholder
          },
          data: { nome },
        });
      }
    }
  }
}
