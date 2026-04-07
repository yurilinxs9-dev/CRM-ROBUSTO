import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';

export const PIPELINE_AUTO_ACTIONS_QUEUE = 'pipeline-auto-actions';

export interface AutoActionJobData {
  leadId: string;
  newStageId: string;
  tenantId: string;
  triggeredByUserId: string;
}

const autoActionSchema = z.object({
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
      send_message: z
        .object({
          content: z.string().min(1),
        })
        .optional(),
      assign_user: z
        .object({
          user_id: z.string().uuid(),
        })
        .optional(),
    })
    .optional(),
});

@Processor(PIPELINE_AUTO_ACTIONS_QUEUE, { concurrency: 3 })
export class PipelineAutoActionsProcessor extends WorkerHost {
  private readonly logger = new Logger(PipelineAutoActionsProcessor.name);

  constructor(
    private prisma: PrismaService,
    private gateway: CrmGateway,
  ) {
    super();
  }

  async process(job: Job<AutoActionJobData>): Promise<void> {
    const { leadId, newStageId, tenantId, triggeredByUserId } = job.data;

    const stage = await this.prisma.stage.findFirst({
      where: { id: newStageId, tenant_id: tenantId },
      select: { id: true, auto_action: true },
    });
    if (!stage || !stage.auto_action) return;

    const parsed = autoActionSchema.safeParse(stage.auto_action);
    if (!parsed.success) {
      this.logger.warn(
        `auto_action invalid for stage ${newStageId}: ${parsed.error.message}`,
      );
      return;
    }

    const onEnter = parsed.data.on_enter;
    if (!onEnter) return;

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true, telefone: true },
    });
    if (!lead) return;

    if (onEnter.assign_user) {
      try {
        await this.prisma.lead.update({
          where: { id: leadId },
          data: { responsavel_id: onEnter.assign_user.user_id },
        });
      } catch (err) {
        this.logger.warn(`assign_user failed for lead ${leadId}: ${String(err)}`);
      }
    }

    if (onEnter.create_task) {
      try {
        const scheduledAt = new Date(Date.now() + onEnter.create_task.offset_min * 60_000);
        const task = await this.prisma.task.create({
          data: {
            titulo: onEnter.create_task.titulo,
            tipo: onEnter.create_task.tipo,
            scheduled_at: scheduledAt,
            lead_id: leadId,
            responsavel_id: onEnter.assign_user?.user_id ?? lead.responsavel_id,
            tenant_id: tenantId,
          },
        });
        this.gateway.emitTaskCreated(task.responsavel_id, task);
      } catch (err) {
        this.logger.warn(`create_task failed for lead ${leadId}: ${String(err)}`);
      }
    }

    if (onEnter.send_message) {
      try {
        await this.prisma.message.create({
          data: {
            lead_id: leadId,
            instance_name: lead.instancia_whatsapp || 'auto',
            direction: 'OUTGOING',
            type: 'TEXT',
            content: onEnter.send_message.content,
            status: 'PENDING',
            is_internal_note: true,
            sent_by_user_id: triggeredByUserId,
            tenant_id: tenantId,
          },
        });
      } catch (err) {
        this.logger.warn(`send_message failed for lead ${leadId}: ${String(err)}`);
      }
    }
  }
}
