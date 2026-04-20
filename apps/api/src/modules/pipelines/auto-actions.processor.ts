import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { MessagesService } from '../messages/messages.service';

export const PIPELINE_AUTO_ACTIONS_QUEUE = 'pipeline-auto-actions';

export interface AutoActionJobData {
  leadId: string;
  newStageId: string;
  tenantId: string;
  triggeredByUserId: string;
}

// Legacy format (auto_action field)
const legacyActionSchema = z.object({
  on_enter: z
    .object({
      create_task: z
        .object({
          titulo: z.string().min(1),
          tipo: z
            .enum(['FOLLOW_UP', 'LIGACAO', 'REUNIAO', 'EMAIL', 'VISITA', 'OUTRO'])
            .default('FOLLOW_UP'),
          offset_min: z.number().int().nonnegative().default(60),
        })
        .optional(),
      send_message: z.object({ content: z.string().min(1) }).optional(),
      assign_user: z.object({ user_id: z.string().uuid() }).optional(),
    })
    .optional(),
});

// New format (on_entry_config field)
const entryConfigSchema = z.object({
  createTask: z
    .object({
      enabled: z.boolean().default(false),
      title: z.string().optional(),
      due_duration: z.number().int().nonnegative().default(1),
      due_unit: z.enum(['MINUTES', 'HOURS', 'DAYS']).default('HOURS'),
    })
    .optional(),
  sendInitialMessage: z
    .object({
      enabled: z.boolean().default(false),
      text: z.string().optional(),
    })
    .optional(),
  assignResponsible: z
    .object({ enabled: z.boolean().default(false) })
    .optional(),
});

function durationToMs(duration: number, unit: string): number {
  if (unit === 'MINUTES') return duration * 60_000;
  if (unit === 'HOURS') return duration * 3_600_000;
  return duration * 86_400_000;
}

@Processor(PIPELINE_AUTO_ACTIONS_QUEUE, { concurrency: 3 })
export class PipelineAutoActionsProcessor extends WorkerHost {
  private readonly logger = new Logger(PipelineAutoActionsProcessor.name);

  constructor(
    private prisma: PrismaService,
    private gateway: CrmGateway,
    private messages: MessagesService,
  ) {
    super();
  }

  async process(job: Job<AutoActionJobData>): Promise<void> {
    const { leadId, newStageId, tenantId, triggeredByUserId } = job.data;

    const stage = await this.prisma.stage.findFirst({
      where: { id: newStageId, tenant_id: tenantId },
      select: { id: true, auto_action: true, on_entry_config: true },
    });
    if (!stage) return;

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true, telefone: true },
    });
    if (!lead) return;

    // Try new on_entry_config first, fall back to legacy auto_action
    if (stage.on_entry_config) {
      await this.processEntryConfig(stage.on_entry_config, leadId, newStageId, tenantId, triggeredByUserId, lead);
    } else if (stage.auto_action) {
      await this.processLegacyAction(stage.auto_action, leadId, tenantId, triggeredByUserId, lead);
    }
  }

  private async processEntryConfig(
    raw: unknown,
    leadId: string,
    stageId: string,
    tenantId: string,
    triggeredByUserId: string,
    lead: { id: string; responsavel_id: string | null; instancia_whatsapp: string | null; telefone: string },
  ) {
    const parsed = entryConfigSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`on_entry_config inválido para stage ${stageId}: ${parsed.error.message}`);
      return;
    }
    const cfg = parsed.data;

    // 1. Atribuir responsável por round-robin (menor carga na etapa)
    if (cfg.assignResponsible?.enabled) {
      try {
        const users = await this.prisma.user.findMany({
          where: { tenant_id: tenantId, ativo: true },
          select: { id: true },
          orderBy: { created_at: 'asc' },
        });
        if (users.length > 0) {
          // Distribui por modulo do timestamp — aproximação de round-robin sem estado
          const picked = users[Date.now() % users.length];
          await this.prisma.lead.update({
            where: { id: leadId },
            data: { responsavel_id: picked.id },
          });
          lead.responsavel_id = picked.id;
        }
      } catch (err) {
        this.logger.warn(`assignResponsible (round-robin) falhou para lead ${leadId}: ${String(err)}`);
      }
    }

    // 2. Criar tarefa automática
    if (cfg.createTask?.enabled && cfg.createTask.title && lead.responsavel_id) {
      try {
        const offsetMs = durationToMs(cfg.createTask.due_duration ?? 1, cfg.createTask.due_unit ?? 'HOURS');
        const scheduledAt = new Date(Date.now() + offsetMs);
        const task = await this.prisma.task.create({
          data: {
            titulo: cfg.createTask.title,
            tipo: 'FOLLOW_UP',
            scheduled_at: scheduledAt,
            lead_id: leadId,
            responsavel_id: lead.responsavel_id,
            tenant_id: tenantId,
          },
        });
        this.gateway.emitTaskCreated(task.responsavel_id, task);
      } catch (err) {
        this.logger.warn(`createTask falhou para lead ${leadId}: ${String(err)}`);
      }
    }

    // 3. Enviar mensagem de boas-vindas via WhatsApp
    if (cfg.sendInitialMessage?.enabled && cfg.sendInitialMessage.text) {
      try {
        await this.messages.sendText(
          { lead_id: leadId, content: cfg.sendInitialMessage.text },
          { tenantId, id: triggeredByUserId, role: 'OPERADOR' } as any,
        );
      } catch (err) {
        this.logger.warn(`sendInitialMessage falhou para lead ${leadId}: ${String(err)}`);
      }
    }
  }

  private async processLegacyAction(
    raw: unknown,
    leadId: string,
    tenantId: string,
    triggeredByUserId: string,
    lead: { id: string; responsavel_id: string | null; instancia_whatsapp: string | null; telefone: string },
  ) {
    const parsed = legacyActionSchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.warn(`auto_action inválido: ${parsed.error.message}`);
      return;
    }
    const onEnter = parsed.data.on_enter;
    if (!onEnter) return;

    if (onEnter.assign_user) {
      try {
        await this.prisma.lead.update({
          where: { id: leadId },
          data: { responsavel_id: onEnter.assign_user.user_id },
        });
      } catch (err) {
        this.logger.warn(`assign_user falhou para lead ${leadId}: ${String(err)}`);
      }
    }

    if (onEnter.create_task) {
      const taskOwner = onEnter.assign_user?.user_id ?? lead.responsavel_id;
      if (taskOwner) {
        try {
          const scheduledAt = new Date(Date.now() + onEnter.create_task.offset_min * 60_000);
          const task = await this.prisma.task.create({
            data: {
              titulo: onEnter.create_task.titulo,
              tipo: onEnter.create_task.tipo,
              scheduled_at: scheduledAt,
              lead_id: leadId,
              responsavel_id: taskOwner,
              tenant_id: tenantId,
            },
          });
          this.gateway.emitTaskCreated(task.responsavel_id, task);
        } catch (err) {
          this.logger.warn(`create_task falhou para lead ${leadId}: ${String(err)}`);
        }
      }
    }

    if (onEnter.send_message) {
      try {
        await this.messages.sendText(
          { lead_id: leadId, content: onEnter.send_message.content },
          { tenantId, id: triggeredByUserId, role: 'OPERADOR' } as any,
        );
      } catch (err) {
        this.logger.warn(`send_message falhou para lead ${leadId}: ${String(err)}`);
      }
    }
  }
}
