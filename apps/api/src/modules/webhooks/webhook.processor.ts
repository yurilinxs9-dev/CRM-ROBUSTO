import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import type { MessageType, Prisma, WhatsappInstance } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { MediaService } from '../media/media.service';
import { MediaPipelineService } from '../media/media-pipeline.service';
import { PushService } from '../push/push.service';
import {
  type ExtractedMessage,
  extractFromEvolution,
  extractFromUazapi,
  extractFromWpp,
  synthesizeMessageId,
} from './message-extractor';
import {
  assertValidMagic,
  decryptWhatsAppMedia,
  messageTypeToMediaType,
} from './media-crypto';

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
    private mediaPipeline: MediaPipelineService,
    private push: PushService,
  ) {
    super();
  }

  @OnWorkerEvent('failed')
  onFailed(job: Job | undefined, err: Error) {
    // Surface silent BullMQ failures in container logs so bugs like the
    // stale Prisma Client / missing column don't hide as queue "failed" count.
    this.logger.error(
      `Webhook job FAILED name=${job?.name ?? '?'} id=${job?.id ?? '?'} attempts=${job?.attemptsMade ?? 0}: ${err?.message ?? err}`,
      err?.stack,
    );
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
        case 'uazapi.chats':
          await this.handleUazapiChats(job.data);
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
   * Unified message persistence — optimized for realtime delivery.
   *
   * Critical-path order:
   *   1. ensure pipeline/lead (cheap)
   *   2. upsert message WITHOUT media (cheap)
   *   3. emit `message:new` IMMEDIATELY (text/control rendered instantly)
   *   4. background: download → upload → DB update → emit `message:media-ready`
   *
   * Why: previously the gateway waited for the Evolution media download
   * AND a Supabase upload before emitting, adding seconds of latency to every
   * voice note / image. Now text messages are <100ms p99 and media reaches the
   * client in two phases (skeleton then ready).
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

    // CRITICAL: never use `pushName` when isFromMe=true. The Evolution webhook
    // populates pushName from the SENDER, so for outgoing messages it is the
    // owner's own name (e.g. "Yuri Lins"), not the contact's. Writing it as
    // the lead `nome` corrupted every customer the user messaged into a
    // duplicate of the owner's name. Only trust pushName for incoming.
    const incomingPushName = !isFromMe && pushName ? pushName.trim() : undefined;

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { pool_enabled: true },
    });

    // Instância dona de SUPER_ADMIN/GERENTE auto-atribui sempre ao dono,
    // mesmo com pool_enabled=true. Só OPERADOR cai no pool quando ativo.
    const ownerUser = instance.owner_user_id
      ? await this.prisma.user.findUnique({
          where: { id: instance.owner_user_id },
          select: { role: true },
        })
      : null;
    const ownerIsManager =
      ownerUser?.role === 'SUPER_ADMIN' || ownerUser?.role === 'GERENTE';
    const responsavelId =
      tenant?.pool_enabled && !ownerIsManager ? null : instance.owner_user_id;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: ctx.pipeline.id } },
      create: {
        nome: incomingPushName || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instance.nome,
        pipeline_id: ctx.pipeline.id,
        estagio_id: ctx.firstStage.id,
        estagio_entered_at: new Date(),
        responsavel_id: responsavelId,
        ultima_interacao: new Date(),
        last_customer_message_at: isFromMe ? undefined : new Date(),
        tenant_id: tenantId,
      },
      // Em update NÃO mexe em responsavel_id nem instancia_whatsapp:
      // se um operador já assumiu o lead (claim/reassign), as msgs novas
      // do cliente não podem reverter a posse pra o dono da instância.
      // O re-assign automático só acontece se o lead ainda está no pool
      // (responsavel_id IS NULL), tratado abaixo.
      update: {
        ultima_interacao: new Date(),
        last_customer_message_at: isFromMe ? undefined : new Date(),
        last_agent_message_at: isFromMe ? new Date() : undefined,
        mensagens_nao_lidas: { increment: isFromMe ? 0 : 1 },
      },
    });

    // Auto-assign só na situação clássica: lead em pool e dono da instância
    // é admin/gerente (modo Compartilhado) ou modo Individual. Nunca sobrepõe
    // claim humana.
    if (lead.responsavel_id === null && responsavelId !== null) {
      const fixed = await this.prisma.lead.update({
        where: { id: lead.id },
        data: { responsavel_id: responsavelId, instancia_whatsapp: instance.nome },
      });
      lead.responsavel_id = fixed.responsavel_id;
      lead.instancia_whatsapp = fixed.instancia_whatsapp;
    }

    // Heal lead names that were corrupted before the fix above shipped.
    // If the stored name is the bare phone OR matches the owner's pushName
    // (i.e. previously corrupted), and we now have a real incoming pushName,
    // overwrite it.
    if (incomingPushName && lead.nome !== incomingPushName) {
      const looksCorrupted =
        lead.nome === lead.telefone || /^\+?\d{8,}$/.test(lead.nome.trim());
      if (looksCorrupted) {
        await this.prisma.lead.update({
          where: { id: lead.id },
          data: { nome: incomingPushName },
        });
        lead.nome = incomingPushName;
      }
    }

    // Synthesize id when webhook omits it — never drop the message
    if (!messageId) {
      messageId = synthesizeMessageId(lead.id);
      this.logger.warn(
        `messageId ausente — gerado sintetico ${messageId} para lead ${lead.id}`,
      );
    }

    const metadata: Prisma.InputJsonValue = {
      raw: JSON.parse(JSON.stringify(rawPayload)) as unknown as Prisma.InputJsonValue,
      ...(extracted.location ? { location: extracted.location } : {}),
      ...(extracted.contact ? { contact: extracted.contact } : {}),
    };

    // Echo dedup: when isFromMe=true, this webhook PODE ser o eco de uma
    // mensagem enviada pelo CRM (em que já criamos a linha + emitimos
    // message:new) — ou pode ser uma msg enviada DO CELULAR nativo, que é
    // first sight pra gente. A diferença está no whatsapp_message_id:
    //   - CRM-send → wa_id NULL ou UUID placeholder (esperando o eco
    //     trazer o id real do WhatsApp).
    //   - msg do celular → não há linha local, sempre cai no upsert+emit.
    //
    // Bug anterior: matchávamos por content+lead+direction nos últimos 2min.
    // Isso fazia msgs do celular com conteúdo idêntico a um CRM-send
    // recente serem "absorvidas" no eco — o webhook era ignorado, msg do
    // celular nunca aparecia em tempo real. Fix: janela curta (30s) +
    // confirmar que o wa_id local é placeholder antes de re-vincular.
    const isPlaceholderWaId = (id: string | null): boolean => {
      if (!id) return true;
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
    };
    if (isFromMe) {
      const existingByWaId = await this.prisma.message.findUnique({
        where: {
          tenant_id_whatsapp_message_id: {
            tenant_id: tenantId,
            whatsapp_message_id: messageId,
          },
        },
      });
      if (existingByWaId) {
        this.logger.log(
          `dedup HIT existingByWaId msgId=${messageId} lead=${lead.id} — skip emit`,
        );
        return;
      }
      const recentLocal = await this.prisma.message.findFirst({
        where: {
          lead_id: lead.id,
          direction: 'OUTGOING',
          type: extracted.type as MessageType,
          content: extracted.content,
          created_at: { gte: new Date(Date.now() - 30 * 1000) },
        },
        orderBy: { created_at: 'desc' },
      });
      if (
        recentLocal &&
        recentLocal.whatsapp_message_id !== messageId &&
        isPlaceholderWaId(recentLocal.whatsapp_message_id)
      ) {
        this.logger.log(
          `dedup HIT recentLocal lead=${lead.id} localId=${recentLocal.id} ` +
          `localWaId=${recentLocal.whatsapp_message_id ?? 'null'} → ${messageId} — skip emit`,
        );
        await this.prisma.message.update({
          where: { id: recentLocal.id },
          data: { whatsapp_message_id: messageId },
        });
        return;
      }
      if (recentLocal) {
        this.logger.log(
          `dedup MISS lead=${lead.id} reason=${
            recentLocal.whatsapp_message_id === messageId ? 'same-id' : 'real-wa-id'
          } localWaId=${recentLocal.whatsapp_message_id ?? 'null'} — proceed upsert+emit`,
        );
      }
    }

    // Persist the message WITHOUT media first — keeps the realtime emit fast.
    // Race-safe: BullMQ may dispatch the same payload to two workers; the
    // upsert can lose the create→create race (P2002) before Prisma sees the
    // existing row. Catch and treat as "already saved by sibling worker".
    let message;
    try {
      message = await this.prisma.message.upsert({
      where: {
        tenant_id_whatsapp_message_id: {
          tenant_id: tenantId,
          whatsapp_message_id: messageId,
        },
      },
      create: {
        lead_id: lead.id,
        instance_name: instance.nome,
        whatsapp_message_id: messageId,
        direction: isFromMe ? 'OUTGOING' : 'INCOMING',
        type: extracted.type as MessageType,
        content: extracted.content,
        media_url: null,
        media_mimetype: extracted.media?.mimetype,
        media_duration_seconds: extracted.media?.duration_seconds,
        media_filename: extracted.media?.filename,
        media_size_bytes: extracted.media?.size_bytes,
        status: isFromMe ? 'SENT' : 'DELIVERED',
        metadata,
        visible_to_user_id: lead.responsavel_id ?? null,
        tenant_id: tenantId,
      },
      update: {},
    });
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'P2002') {
        const existing = await this.prisma.message.findUnique({
          where: {
            tenant_id_whatsapp_message_id: {
              tenant_id: tenantId,
              whatsapp_message_id: messageId,
            },
          },
        });
        if (!existing) throw err;
        message = existing;
      } else {
        throw err;
      }
    }

    // Invalidate cache BEFORE emitting WS so client refetch hits a fresh list.
    // For media messages the client renders a placeholder (skeleton/loading)
    // until the `message:media-ready` event arrives.
    if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);
    this.gateway.emitNewMessage(lead.id, message, tenantId);

    if (!isFromMe) {
      const preview = extracted.content?.slice(0, 80) ?? `[${extracted.type}]`;
      let targetUserIds: string[];
      if (lead.responsavel_id) {
        targetUserIds = [lead.responsavel_id];
      } else if (tenantId) {
        const poolUsers = await this.prisma.user.findMany({
          where: { tenant_id: tenantId, ativo: true, role: { not: 'VISUALIZADOR' } },
          select: { id: true },
        });
        targetUserIds = poolUsers.map((u) => u.id);
      } else {
        targetUserIds = [];
      }
      if (targetUserIds.length > 0) {
        void this.push.sendToUsers(targetUserIds, {
          title: lead.nome,
          body: preview,
          url: `/leads/${lead.id}`,
          tag: `msg-${lead.id}`,
          data: { leadId: lead.id, type: 'message' },
        });
      }
    }

    // Background: download from Evolution, upload to Supabase, sign,
    // patch DB, and emit a media-ready event so the client renders the audio.
    if (extracted.media?.url) {
      void this.processMediaInBackground({
        tenantId,
        leadId: lead.id,
        messageId: message.id,
        whatsappMessageId: messageId,
        extracted,
      });
    }

    // Sync profile (name + photo) in background — never blocks realtime.
    // Trigger when name is placeholder, photo is missing, OR stored URL is a
    // raw WhatsApp CDN link (`pps.whatsapp.net`) which expires within hours
    // and starts returning 403 once the `oe=` timestamp passes.
    const fotoStale = lead.foto_url?.includes('pps.whatsapp.net') ?? false;
    if (lead.nome === lead.telefone || !lead.foto_url || fotoStale) {
      void this.leadsService.syncProfileSafe(lead.id);
    }
  }

  /**
   * Off-critical-path: download remote media → upload to Supabase Storage →
   * update message row → emit `message:media-ready` so the client patches
   * the cached message and the audio/image renders without a refresh.
   *
   * For IMAGE and VIDEO messages, also runs MediaPipelineService to extract
   * thumbnail/poster and dimension metadata.
   */
  private async processMediaInBackground(input: {
    tenantId: string;
    leadId: string;
    messageId: string;
    whatsappMessageId: string;
    extracted: ExtractedMessage;
  }): Promise<void> {
    try {
      // Download the raw buffer once so we can reuse it for pipeline processing.
      const mediaUrl = input.extracted.media?.url;
      if (!mediaUrl || !/^https?:\/\//i.test(mediaUrl)) return;

      const rawBuf = await this.downloadMedia(mediaUrl);
      if (!rawBuf) return;

      const mimetype = input.extracted.media?.mimetype ?? 'application/octet-stream';
      const mediaKey = input.extracted.media?.mediaKey;

      // Decrypt WhatsApp E2E encrypted media if mediaKey is present.
      let buf: Buffer;
      if (mediaKey) {
        try {
          const cryptoType = messageTypeToMediaType(input.extracted.type);
          buf = decryptWhatsAppMedia(rawBuf, mediaKey, cryptoType);
        } catch (err) {
          this.logger.error(
            `Decryption failed msg=${input.messageId} waId=${input.whatsappMessageId}: ${String(err)}`,
          );
          return;
        }
      } else {
        // No mediaKey — assume already decrypted (e.g. from APIs that handle decryption).
        buf = rawBuf;
      }

      // Validate magic bytes — never store corrupted/encrypted data.
      try {
        assertValidMagic(buf, mimetype, input.messageId);
      } catch (err) {
        this.logger.error(String(err));
        return;
      }

      const ext = this.extFromMime(mimetype, 'bin');
      const folder = input.extracted.type.toLowerCase();
      const storagePath = `${input.tenantId}/${folder}/${input.whatsappMessageId}.${ext}`;

      try {
        await this.mediaService.upload(storagePath, buf, mimetype);
      } catch (err) {
        this.logger.warn(`Falha upload media ${storagePath}: ${String(err)}`);
        return;
      }

      // Base DB update.
      const dbUpdate: Record<string, unknown> = { media_url: storagePath };

      // Enhanced processing for IMAGE and VIDEO.
      if (input.extracted.type === 'IMAGE') {
        try {
          const pipe = await this.mediaPipeline.processImage(buf);
          const thumbPath = `${input.tenantId}/image/${input.whatsappMessageId}.thumb.jpg`;
          await this.mediaService.upload(thumbPath, pipe.thumbnail.buffer, pipe.thumbnail.mimetype);
          dbUpdate['media_thumbnail_path'] = thumbPath;
          if (pipe.width != null)  dbUpdate['media_width']  = pipe.width;
          if (pipe.height != null) dbUpdate['media_height'] = pipe.height;
        } catch (err) {
          this.logger.warn(`Image pipeline failed for ${input.whatsappMessageId}: ${String(err)}`);
        }
      } else if (input.extracted.type === 'VIDEO') {
        try {
          const pipe = await this.mediaPipeline.processVideo(buf, mimetype);
          const posterPath = `${input.tenantId}/video/${input.whatsappMessageId}.poster.jpg`;
          await this.mediaService.upload(posterPath, pipe.poster.buffer, pipe.poster.mimetype);
          dbUpdate['media_poster_path'] = posterPath;
          if (pipe.width != null)             dbUpdate['media_width']            = pipe.width;
          if (pipe.height != null)            dbUpdate['media_height']           = pipe.height;
          if (pipe.duration_seconds != null)  dbUpdate['media_duration_seconds'] = pipe.duration_seconds;
        } catch (err) {
          this.logger.warn(`Video pipeline failed for ${input.whatsappMessageId}: ${String(err)}`);
        }
      }

      await this.prisma.message.update({
        where: { id: input.messageId },
        data: dbUpdate as Prisma.MessageUpdateInput,
      });

      let signedUrl: string | null = null;
      try {
        signedUrl = await this.mediaService.getSignedUrl(storagePath, 60 * 60);
      } catch (err) {
        this.logger.warn(
          `Falha assinando media ${storagePath}: ${String(err)}`,
        );
      }
      if (!signedUrl) return;

      this.gateway.emitMessageMediaReady(input.leadId, {
        messageId: input.messageId,
        media_url: signedUrl,
        media_mimetype: input.extracted.media?.mimetype ?? null,
      });
    } catch (err) {
      this.logger.error(
        `processMediaInBackground falhou para ${input.whatsappMessageId}: ${String(err)}`,
      );
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
      where: { id: instance.id },
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
      if (!mappedStatus) continue;

      // wa_id deixou de ser único globalmente (composto com tenant_id), então
      // a mesma id pode aparecer em múltiplas perspectivas. updateMany cobre
      // todas; emitMessageStatusUpdate dispara por linha encontrada.
      const matches = await this.prisma.message.findMany({
        where: { whatsapp_message_id: messageId },
        select: { id: true, lead_id: true, tenant_id: true },
      });
      if (matches.length === 0) continue;

      await this.prisma.message.updateMany({
        where: { whatsapp_message_id: messageId },
        data: { status: mappedStatus as 'DELIVERED' | 'READ' | 'FAILED' },
      });
      for (const m of matches) {
        this.gateway.emitMessageStatusUpdate(m.lead_id, m.id, mappedStatus);
      }
    }
  }

  private async handleConnectionUpdate(data: Obj) {
    const instanceName = data?.instance as string | undefined;
    const connectionData = data?.data as Obj | undefined;
    const rawState = (connectionData?.state as string | undefined) ?? 'disconnected';
    if (!instanceName) return;

    const stateMap: Record<string, string> = {
      connected: 'open',
      open: 'open',
      connecting: 'connecting',
      disconnected: 'close',
      close: 'close',
    };
    const status = stateMap[rawState] ?? rawState;

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) return;
    await this.prisma.whatsappInstance.update({
      where: { id: instance.id },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instanceName, status, instance.tenant_id);
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

    const matches = await this.prisma.message.findMany({
      where: { whatsapp_message_id: messageId },
      select: { id: true, lead_id: true },
    });
    if (matches.length === 0) return;

    await this.prisma.message.updateMany({
      where: { whatsapp_message_id: messageId },
      data: { status: mapped },
    });
    for (const m of matches) {
      this.gateway.emitMessageStatusUpdate(m.lead_id, m.id, mapped);
    }
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
      where: { id: instance.id },
      data: { status, ultimo_check: new Date() },
    });
    this.gateway.emitInstanceStatusChanged(instance.nome, status, instance.tenant_id);
  }

  private async handleUazapiChats(payload: Obj) {
    const chat = payload?.chat as Obj | undefined;
    if (!chat) return;
    if (chat.wa_isGroup === true) return;

    const unreadCount = chat.wa_unreadCount as number | undefined;
    if (unreadCount !== 0) return; // Only act when conversation was read (unread → 0)

    // Extract phone: prefer wa_chatid (already normalized), fall back to chat.phone
    const chatId = chat.wa_chatid as string | undefined;
    const rawPhone = chat.phone as string | undefined;
    const phone = chatId
      ? chatId.split('@')[0].replace(/\D/g, '')
      : rawPhone?.replace(/\D/g, '') ?? '';
    if (!phone) return;

    const token = payload.token as string | undefined;
    const instance = await this.findInstanceByUazapiToken(token);
    if (!instance) return;

    const lead = await this.prisma.lead.findFirst({
      where: { telefone: phone, tenant_id: instance.tenant_id },
      select: { id: true, mensagens_nao_lidas: true },
    });
    if (!lead) return; // Lead doesn't exist in CRM — ignore
    if (lead.mensagens_nao_lidas === 0) return; // Already zero — no-op

    await this.prisma.lead.update({
      where: { id: lead.id },
      data: { mensagens_nao_lidas: 0 },
    });

    this.gateway.emitLeadUnreadReset(lead.id, instance.tenant_id);
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
      // NOTE: deliberately NOT persisting `contact.profilePictureUrl` here.
      // Evolution forwards the raw `pps.whatsapp.net` signed URL, which expires
      // within hours and then returns 403. The avatar is mirrored to Supabase
      // Storage by `LeadsService.syncProfile()` (triggered on next inbound
      // message and by the daily cron), so we just skip the photo at this
      // bulk-upsert stage.
      if (!nome) continue;

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
