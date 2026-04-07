import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { LeadsService } from '../leads/leads.service';
import { CrmGateway } from '../websocket/websocket.gateway';

@Processor('webhooks', { concurrency: 3 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(
    private prisma: PrismaService,
    private leadsService: LeadsService,
    private gateway: CrmGateway,
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

  private async ensurePipelineAndStage(tenantId: string) {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { ativo: true, tenant_id: tenantId },
    });
    if (!pipeline) return null;
    const firstStage = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipeline.id, tenant_id: tenantId },
      orderBy: { ordem: 'asc' },
    });
    if (!firstStage) return null;
    return { pipeline, firstStage };
  }

  // ── WPPConnect handlers ──────────────────────────────────────────────────────

  private async handleWppMessage(payload: Record<string, unknown>) {
    const instanceName = payload?.instance as string | undefined;
    const msg = payload?.data as Record<string, unknown> | undefined;
    if (!msg) return;
    if (msg.isGroupMsg === true) return;

    const from = msg.from as string | undefined;
    if (!from) return;

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) {
      this.logger.warn(`WPP message para instancia desconhecida: ${instanceName}`);
      return;
    }
    const tenantId = instance.tenant_id;
    const ownerId = instance.owner_user_id;

    const phone = from.replace('@c.us', '').replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const msgIdObj = msg.id as Record<string, unknown> | undefined;
    const messageId = (msgIdObj?._serialized as string) || (msg.id as string) || undefined;
    const isFromMe = (msg.fromMe as boolean) || false;
    const content = (msg.body as string) || null;

    const ctx = await this.ensurePipelineAndStage(tenantId);
    if (!ctx) return;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: ctx.pipeline.id } },
      create: {
        nome: (msg.pushName as string) || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instance.nome,
        pipeline_id: ctx.pipeline.id,
        estagio_id: ctx.firstStage.id,
        responsavel_id: ownerId,
        ultima_interacao: new Date(),
        tenant_id: tenantId,
      },
      update: {
        ultima_interacao: new Date(),
        mensagens_nao_lidas: { increment: isFromMe ? 0 : 1 },
      },
    });

    if (messageId) {
      const message = await this.prisma.message.upsert({
        where: { whatsapp_message_id: messageId },
        create: {
          lead_id: lead.id,
          instance_name: instance.nome,
          whatsapp_message_id: messageId,
          direction: isFromMe ? 'OUTGOING' : 'INCOMING',
          type: 'TEXT',
          content,
          status: isFromMe ? 'SENT' : 'DELIVERED',
          metadata: JSON.parse(JSON.stringify(payload)),
          tenant_id: tenantId,
        },
        update: {},
      });
      this.gateway.emitNewMessage(lead.id, message, tenantId);
      if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);
    }
  }

  private async handleWppStatus(payload: Record<string, unknown>) {
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

  // ── Legacy Evolution API handlers ───────────────────────────────────────────

  private async handleMessageUpsert(data: Record<string, unknown>) {
    const rawData = data?.data as Record<string, unknown> | undefined;
    const msg = (rawData?.message || rawData) as Record<string, unknown> | undefined;
    if (!msg) return;

    const instanceName = data?.instance as string | undefined;
    const key = msg?.key as Record<string, unknown> | undefined;
    const remoteJid = key?.remoteJid as string | undefined;
    if (!remoteJid || remoteJid.includes('@g.us')) return;

    const instance = await this.findInstanceByName(instanceName);
    if (!instance) return;
    const tenantId = instance.tenant_id;

    const phone = remoteJid.replace('@s.whatsapp.net', '').replace(/\D/g, '');
    const messageId = key?.id as string | undefined;
    const isFromMe = key?.fromMe as boolean;
    const messageContent = msg?.message as Record<string, unknown> | undefined;
    const content = (messageContent?.conversation ||
                    (messageContent?.extendedTextMessage as Record<string, unknown>)?.text || null) as string | null;

    const ctx = await this.ensurePipelineAndStage(tenantId);
    if (!ctx) return;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: ctx.pipeline.id } },
      create: {
        nome: (msg?.pushName as string) || phone,
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

    if (messageId) {
      const message = await this.prisma.message.upsert({
        where: { whatsapp_message_id: messageId },
        create: {
          lead_id: lead.id,
          instance_name: instance.nome,
          whatsapp_message_id: messageId,
          direction: isFromMe ? 'OUTGOING' : 'INCOMING',
          type: 'TEXT',
          content,
          status: isFromMe ? 'SENT' : 'DELIVERED',
          metadata: JSON.parse(JSON.stringify(data)),
          tenant_id: tenantId,
        },
        update: {},
      });
      this.gateway.emitNewMessage(lead.id, message, tenantId);
      if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);
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

  private async handleConnectionUpdate(data: Record<string, unknown>) {
    const instanceName = data?.instance as string | undefined;
    const connectionData = data?.data as Record<string, unknown> | undefined;
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

  private async handleUazapiMessage(payload: Record<string, unknown>) {
    const message = payload?.message as Record<string, unknown> | undefined;
    if (!message) return;
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
    const instance = await this.findInstanceByUazapiToken(token);
    if (!instance) {
      this.logger.warn(`UazAPI message com token desconhecido`);
      return;
    }
    const tenantId = instance.tenant_id;
    const instanceName = instance.nome;

    const ctx = await this.ensurePipelineAndStage(tenantId);
    if (!ctx) return;

    const lead = await this.prisma.lead.upsert({
      where: { telefone_pipeline_id: { telefone: phone, pipeline_id: ctx.pipeline.id } },
      create: {
        nome: (message.senderName as string | undefined) || (message.pushName as string | undefined) || phone,
        telefone: phone,
        origem: 'WHATSAPP_INCOMING',
        instancia_whatsapp: instanceName,
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

    if (messageId) {
      const stored = await this.prisma.message.upsert({
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
          tenant_id: tenantId,
        },
        update: {},
      });
      this.gateway.emitNewMessage(lead.id, stored, tenantId);
      if (tenantId) await this.leadsService.invalidateLeadsCache(tenantId);
    }

    if (lead.nome === lead.telefone || !lead.foto_url) {
      void this.leadsService.syncProfileSafe(lead.id);
    }
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
    this.gateway.emitInstanceStatusChanged(instance.nome, status, instance.tenant_id);
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
