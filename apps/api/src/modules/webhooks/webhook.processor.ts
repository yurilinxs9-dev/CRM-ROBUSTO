import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';

@Processor('webhooks', { concurrency: 3 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private prisma: PrismaService,
    private leadsService: LeadsService,
  ) {
    super();
  }

  async process(job: Job) {
    const start = Date.now();
    try {
      switch (job.name) {
        // WPPConnect events
        case 'onmessage':
          await this.handleWppMessage(job.data);
          break;
        case 'status-find':
          await this.handleWppStatus(job.data);
          break;
        // Legacy Evolution API events (kept for compatibility)
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
        // UazAPI events (UazAPI uses plural "messages" + EventType field)
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
          this.logger.debug(`Evento nao processado: ${job.name}`);
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

  // ── WPPConnect handlers ──────────────────────────────────────────────────────

  private async handleWppMessage(payload: Record<string, unknown>) {
    const instanceName = payload?.instance as string | undefined;
    const msg = payload?.data as Record<string, unknown> | undefined;
    if (!msg) return;

    // Skip group messages
    if (msg.isGroupMsg === true) return;

    const from = msg.from as string | undefined;
    if (!from) return;

    const phone = from.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const msgIdObj = msg.id as Record<string, unknown> | undefined;
    const messageId = (msgIdObj?._serialized as string) || (msg.id as string) || undefined;
    const isFromMe = (msg.fromMe as boolean) || false;
    const content = (msg.body as string) || null;

    const pipeline = await this.prisma.pipeline.findFirst({ where: { ativo: true } });
    if (!pipeline) return;

    const firstStage = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipeline.id },
      orderBy: { ordem: 'asc' },
    });
    if (!firstStage) return;

    const defaultUser = await this.prisma.user.findFirst({ where: { ativo: true } });
    if (!defaultUser) return;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: pipeline.id } },
      create: {
        nome: (msg.pushName as string) || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instanceName || '',
        pipeline_id: pipeline.id,
        estagio_id: firstStage.id,
        responsavel_id: defaultUser.id,
        ultima_interacao: new Date(),
      },
      update: {
        ultima_interacao: new Date(),
        mensagens_nao_lidas: { increment: isFromMe ? 0 : 1 },
      },
    });

    if (messageId) {
      await this.prisma.message.upsert({
        where: { whatsapp_message_id: messageId },
        create: {
          lead_id: lead.id,
          instance_name: instanceName || '',
          whatsapp_message_id: messageId,
          direction: isFromMe ? 'OUTGOING' : 'INCOMING',
          type: 'TEXT',
          content,
          status: isFromMe ? 'SENT' : 'DELIVERED',
          metadata: JSON.parse(JSON.stringify(payload)),
        },
        update: {},
      });
    }

    this.logger.log(`Mensagem WPP processada: lead ${lead.id}, phone ${phone}`);
  }

  private async handleWppStatus(payload: Record<string, unknown>) {
    const instanceName = payload?.instance as string | undefined;
    if (!instanceName) return;

    // WPPConnect sends data as a string: "CONNECTED", "QRCODE", "notLogged", etc.
    const rawStatus = payload?.data as string | undefined;
    const statusMap: Record<string, string> = {
      CONNECTED: 'open',
      QRCODE: 'connecting',
      DISCONNECTED: 'close',
      DESTROYED: 'close',
      notLogged: 'close',
    };
    const status = (rawStatus && statusMap[rawStatus]) || 'disconnected';

    await this.prisma.whatsappInstance.upsert({
      where: { nome: instanceName },
      create: { nome: instanceName, status },
      update: { status, ultimo_check: new Date() },
    });
    this.logger.log(`Instancia ${instanceName}: ${rawStatus} → ${status}`);
  }

  // ── Legacy Evolution API handlers ───────────────────────────────────────────

  private async handleMessageUpsert(data: Record<string, unknown>) {
    const rawData = data?.data as Record<string, unknown> | undefined;
    const msg = (rawData?.message || rawData) as Record<string, unknown> | undefined;
    if (!msg) return;

    const instanceName = data?.instance as string | undefined;
    const key = msg?.key as Record<string, unknown> | undefined;
    const remoteJid = key?.remoteJid as string | undefined;
    if (!remoteJid || remoteJid.includes('@g.us')) return;

    const phone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const messageId = key?.id as string | undefined;
    const isFromMe = key?.fromMe as boolean;
    const messageContent = msg?.message as Record<string, unknown> | undefined;
    const content = (messageContent?.conversation ||
                    (messageContent?.extendedTextMessage as Record<string, unknown>)?.text || null) as string | null;

    const pipeline = await this.prisma.pipeline.findFirst({ where: { ativo: true } });
    if (!pipeline) return;

    const firstStage = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipeline.id },
      orderBy: { ordem: 'asc' },
    });
    if (!firstStage) return;

    const defaultUser = await this.prisma.user.findFirst({ where: { ativo: true } });
    if (!defaultUser) return;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: pipeline.id } },
      create: {
        nome: (msg?.pushName as string) || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instanceName || '',
        pipeline_id: pipeline.id,
        estagio_id: firstStage.id,
        responsavel_id: defaultUser.id,
        ultima_interacao: new Date(),
      },
      update: {
        ultima_interacao: new Date(),
        mensagens_nao_lidas: { increment: isFromMe ? 0 : 1 },
      },
    });

    if (messageId) {
      await this.prisma.message.upsert({
        where: { whatsapp_message_id: messageId },
        create: {
          lead_id: lead.id,
          instance_name: instanceName || '',
          whatsapp_message_id: messageId,
          direction: isFromMe ? 'OUTGOING' : 'INCOMING',
          type: 'TEXT',
          content,
          status: isFromMe ? 'SENT' : 'DELIVERED',
          metadata: JSON.parse(JSON.stringify(data)),
        },
        update: {},
      });
    }
  }

  private async handleMessageUpdate(data: Record<string, unknown>) {
    const updates = (data?.data) as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(updates)) return;
    for (const update of updates) {
      const key = update?.key as Record<string, unknown> | undefined;
      const messageId = key?.id as string | undefined;
      const updateData = update?.update as Record<string, unknown> | undefined;
      const status = updateData?.status as string | undefined;
      if (!messageId || !status) continue;

      const statusMap: Record<string, string> = {
        'DELIVERY_ACK': 'DELIVERED',
        'READ': 'READ',
        'PLAYED': 'READ',
        'ERROR': 'FAILED',
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

  private async handleConnectionUpdate(data: Record<string, unknown>) {
    const instanceName = data?.instance as string | undefined;
    const connectionData = data?.data as Record<string, unknown> | undefined;
    const state = connectionData?.state as string | undefined;
    if (!instanceName) return;

    await this.prisma.whatsappInstance.upsert({
      where: { nome: instanceName },
      create: { nome: instanceName, status: state || 'disconnected' },
      update: { status: state || 'disconnected', ultimo_check: new Date() },
    });
  }

  // ── UazAPI handlers ─────────────────────────────────────────────────────────

  private async findInstanceByUazapiToken(token: string | undefined) {
    if (!token) return null;
    const all = await this.prisma.whatsappInstance.findMany();
    return (
      all.find((i) => {
        const cfg = (i.config ?? {}) as Record<string, unknown>;
        return cfg.uazapi_token === token;
      }) ?? null
    );
  }

  private async handleUazapiMessage(payload: Record<string, unknown>) {
    // UazAPI flat format: { EventType, message: {...}, instanceName, owner, token }
    const message = payload?.message as Record<string, unknown> | undefined;
    if (!message) return;

    // Skip group messages
    if (message.isGroup === true) return;

    const chatid = message.chatid as string | undefined;
    if (!chatid) return;

    const phone = chatid.split('@')[0].split(':')[0].replace(/\D/g, '');
    const messageId = (message.messageid as string | undefined) ?? (message.id as string | undefined);
    const isFromMe = !!(message.fromMe as boolean | undefined);

    const content =
      (message.text as string | undefined) ??
      ((message.content as Record<string, unknown> | undefined)?.text as string | undefined) ??
      null;

    const token = payload.token as string | undefined;
    const matchedInstance = await this.findInstanceByUazapiToken(token);
    const instanceName =
      (payload.instanceName as string | undefined) ??
      matchedInstance?.nome ??
      (payload.instanceId as string | undefined) ??
      'unknown';

    const pipeline = await this.prisma.pipeline.findFirst({ where: { ativo: true } });
    if (!pipeline) return;

    const firstStage = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipeline.id },
      orderBy: { ordem: 'asc' },
    });
    if (!firstStage) return;

    const defaultUser = await this.prisma.user.findFirst({ where: { ativo: true } });
    if (!defaultUser) return;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: pipeline.id } },
      create: {
        nome: (message.senderName as string | undefined) || (message.pushName as string | undefined) || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instanceName,
        pipeline_id: pipeline.id,
        estagio_id: firstStage.id,
        responsavel_id: defaultUser.id,
        ultima_interacao: new Date(),
      },
      update: {
        ultima_interacao: new Date(),
        mensagens_nao_lidas: { increment: isFromMe ? 0 : 1 },
      },
    });

    if (messageId) {
      await this.prisma.message.upsert({
        where: { whatsapp_message_id: messageId },
        create: {
          lead_id: lead.id,
          instance_name: instanceName,
          whatsapp_message_id: messageId,
          direction: isFromMe ? 'OUTGOING' : 'INCOMING',
          type: 'TEXT',
          content,
          status: isFromMe ? 'SENT' : 'DELIVERED',
          metadata: JSON.parse(JSON.stringify(payload)),
        },
        update: {},
      });
    }

    // Fire-and-forget: sync profile if nome==telefone or foto_url ausente
    if (lead.nome === lead.telefone || !lead.foto_url) {
      void this.leadsService.syncProfileSafe(lead.id);
    }

    this.logger.log(`Mensagem UazAPI processada: lead ${lead.id}, phone ${phone}`);
  }

  private async handleUazapiMessageAck(payload: Record<string, unknown>) {
    const message = (payload?.message ?? payload?.data) as Record<string, unknown> | undefined;
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

  private async handleUazapiConnectionUpdate(payload: Record<string, unknown>) {
    const instanceField = payload?.instance as Record<string, unknown> | undefined;
    const data = payload?.data as Record<string, unknown> | undefined;
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
  }

  private async handleContactsUpsert(data: Record<string, unknown>) {
    const contacts = data?.data as Array<Record<string, unknown>> | undefined;
    if (!Array.isArray(contacts)) return;
    for (const contact of contacts) {
      const contactId = contact?.id as string | undefined;
      const phone = contactId?.replace('@s.whatsapp.net', '').replace(/\D/g, '');
      if (!phone) continue;
      await this.prisma.lead.updateMany({
        where: { telefone: phone },
        data: {
          nome: (contact?.pushName || contact?.name || undefined) as string | undefined,
          foto_url: (contact?.profilePictureUrl || undefined) as string | undefined,
        },
      });
    }
  }
}
