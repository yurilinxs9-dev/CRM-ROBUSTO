import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';

@Processor('webhooks', { concurrency: 3 })
export class WebhookProcessor extends WorkerHost {
  private readonly logger = new Logger(WebhookProcessor.name);

  constructor(private prisma: PrismaService) {
    super();
  }

  async process(job: Job) {
    const start = Date.now();
    try {
      switch (job.name) {
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

    this.logger.log(`Mensagem processada: lead ${lead.id}, phone ${phone}`);
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
    this.logger.log(`Instancia ${instanceName}: ${state}`);
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
