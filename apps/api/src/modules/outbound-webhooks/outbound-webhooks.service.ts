import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  OUTBOUND_WEBHOOKS_QUEUE,
  OutboundWebhookEvent,
  ALL_EVENTS,
  DispatchJobData,
} from './outbound-webhooks.queue';

const eventEnum = z.enum([
  'message.created',
  'lead.created',
  'lead.updated',
  'deal.won',
  'deal.lost',
]);

export const webhookCreateSchema = z.object({
  name: z.string().min(1).max(100),
  url: z.string().url(),
  events: z.array(eventEnum).min(1),
  active: z.boolean().optional().default(true),
  secret: z.string().max(200).optional().nullable(),
  custom_headers: z.record(z.string()).optional().nullable(),
});

export const webhookUpdateSchema = webhookCreateSchema.partial();

@Injectable()
export class OutboundWebhooksService {
  private readonly logger = new Logger(OutboundWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(OUTBOUND_WEBHOOKS_QUEUE) private readonly queue: Queue<DispatchJobData>,
  ) {}

  async list(tenantId: string) {
    return this.prisma.outboundWebhook.findMany({
      where: { tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
    });
  }

  async get(tenantId: string, id: string) {
    const wh = await this.prisma.outboundWebhook.findFirst({
      where: { id, tenant_id: tenantId },
    });
    if (!wh) throw new NotFoundException('Webhook não encontrado');
    return wh;
  }

  async create(tenantId: string, body: unknown) {
    const data = webhookCreateSchema.parse(body);
    return this.prisma.outboundWebhook.create({
      data: {
        tenant_id: tenantId,
        name: data.name,
        url: data.url,
        events: data.events,
        active: data.active,
        secret: data.secret ?? null,
        custom_headers: data.custom_headers ?? undefined,
      },
    });
  }

  async update(tenantId: string, id: string, body: unknown) {
    await this.get(tenantId, id);
    const data = webhookUpdateSchema.parse(body);
    return this.prisma.outboundWebhook.update({
      where: { id },
      data: {
        ...(data.name !== undefined && { name: data.name }),
        ...(data.url !== undefined && { url: data.url }),
        ...(data.events !== undefined && { events: data.events }),
        ...(data.active !== undefined && { active: data.active }),
        ...(data.secret !== undefined && { secret: data.secret }),
        ...(data.custom_headers !== undefined && { custom_headers: data.custom_headers ?? undefined }),
      },
    });
  }

  async delete(tenantId: string, id: string) {
    await this.get(tenantId, id);
    await this.prisma.outboundWebhook.delete({ where: { id } });
    return { ok: true };
  }

  async listDeliveries(tenantId: string, id: string, limit = 100) {
    await this.get(tenantId, id);
    return this.prisma.webhookDelivery.findMany({
      where: { webhook_id: id },
      orderBy: { created_at: 'desc' },
      take: Math.min(Math.max(limit, 1), 500),
    });
  }

  async test(tenantId: string, id: string) {
    const wh = await this.get(tenantId, id);
    const payload = {
      event_type: 'test',
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      data: { message: 'Payload de teste — confirmação de recebimento' },
    };
    await this.queue.add('dispatch', { webhookId: wh.id, eventType: 'message.created', payload }, {
      attempts: 1,
    });
    return { ok: true, queued: true };
  }

  async dispatch(tenantId: string, eventType: OutboundWebhookEvent, data: Record<string, unknown>) {
    if (!ALL_EVENTS.includes(eventType)) return;
    const hooks = await this.prisma.outboundWebhook.findMany({
      where: { tenant_id: tenantId, active: true, events: { has: eventType } },
      select: { id: true },
    });
    if (hooks.length === 0) return;
    const payload = {
      event_type: eventType,
      timestamp: new Date().toISOString(),
      tenant_id: tenantId,
      data,
    };
    await Promise.all(
      hooks.map((h: { id: string }) =>
        this.queue.add(
          'dispatch',
          { webhookId: h.id, eventType, payload },
          { attempts: 3, backoff: { type: 'exponential', delay: 5_000 } },
        ),
      ),
    );
  }

  async dispatchMessageCreated(args: {
    tenantId: string;
    messageId: string;
    leadId: string;
    text: string | null;
    channel: 'whatsapp';
    direction: 'inbound' | 'outbound';
    type: string;
  }) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: args.leadId },
      select: {
        id: true, nome: true, telefone: true, email: true,
        empresa: true, tags: true, responsavel_id: true,
      },
    });
    return this.dispatch(args.tenantId, 'message.created', {
      message: {
        id: args.messageId,
        text: args.text,
        type: args.type,
        channel: args.channel,
        direction: args.direction,
      },
      contact: lead && {
        id: lead.id,
        name: lead.nome,
        phone: lead.telefone,
        email: lead.email,
        company: lead.empresa,
        tags: lead.tags,
      },
      metadata: {
        assigned_user: lead?.responsavel_id ?? null,
      },
    });
  }

  async dispatchLeadEvent(args: {
    tenantId: string;
    eventType: 'lead.created' | 'lead.updated' | 'deal.won' | 'deal.lost';
    leadId: string;
    changes?: Record<string, unknown>;
  }) {
    const lead = await this.prisma.lead.findUnique({
      where: { id: args.leadId },
      include: {
        estagio: { select: { id: true, nome: true, is_won: true, is_lost: true } },
        pipeline: { select: { id: true, nome: true } },
        responsavel: { select: { id: true, nome: true, email: true } },
      },
    });
    if (!lead) return;
    return this.dispatch(args.tenantId, args.eventType, {
      lead: {
        id: lead.id,
        name: lead.nome,
        phone: lead.telefone,
        email: lead.email,
        company: lead.empresa,
        temperature: lead.temperatura,
        estimated_value: lead.valor_estimado,
        score: lead.score,
        tags: lead.tags,
        custom: lead.dados_custom,
        origem: lead.origem,
        created_at: lead.created_at,
        updated_at: lead.updated_at,
      },
      pipeline: lead.pipeline,
      stage: lead.estagio,
      assigned_user: lead.responsavel,
      changes: args.changes,
    });
  }

  async cleanupOldDeliveries() {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const res = await this.prisma.webhookDelivery.deleteMany({
      where: { created_at: { lt: cutoff } },
    });
    this.logger.log(`Cleanup: ${res.count} deliveries antigas removidas`);
    return res.count;
  }
}
