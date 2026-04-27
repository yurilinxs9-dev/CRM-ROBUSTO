import { Injectable, BadRequestException, NotFoundException, ConflictException, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { MessagesService } from '../messages/messages.service';
import type { AuthUser } from '../../common/types/auth-user';
import { z } from 'zod';

const createPipelineSchema = z.object({
  nome: z.string().min(1).max(100),
  descricao: z.string().max(500).optional().nullable(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icone: z.string().max(50).optional().nullable(),
});

const updatePipelineSchema = z.object({
  nome: z.string().min(1).max(100).optional(),
  descricao: z.string().max(500).optional().nullable(),
  ativo: z.boolean().optional(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  icone: z.string().max(50).optional().nullable(),
});

const createStageSchema = z.object({
  nome: z.string().min(1).max(100),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3498DB'),
  ordem: z.number().int().optional(),
  sla_config: z.any().optional(),
  idle_alert_config: z.any().optional(),
  response_alert_config: z.any().optional(),
  on_entry_config: z.any().optional(),
  cadence_config: z.any().optional(),
});

const updateStageSchema = z.object({
  nome: z.string().min(1).max(100).optional(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  ordem: z.number().int().optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
  max_dias: z.number().int().positive().nullable().optional(),
  auto_action: z.unknown().optional(),
  sla_config: z.any().optional(),
  idle_alert_config: z.any().optional(),
  response_alert_config: z.any().optional(),
  on_entry_config: z.any().optional(),
  cadence_config: z.any().optional(),
});

const reorderStagesSchema = z.object({
  stageIds: z.array(z.string().uuid()).min(1),
});

const reorderPipelinesSchema = z.object({
  pipelineIds: z.array(z.string().uuid()).min(1),
});

const deleteWithMoveSchema = z.object({
  targetPipelineId: z.string().uuid(),
});

@Injectable()
export class PipelinesService {
  private readonly logger = new Logger(PipelinesService.name);

  constructor(
    private prisma: PrismaService,
    private cache: RedisCacheService,
    private messages: MessagesService,
  ) {}

  private async invalidateLeadsCache(tenantId: string): Promise<void> {
    await this.cache.delPattern(`leads:list:${tenantId}:*`);
  }

  async findAll(user: AuthUser, includeArchived = false) {
    return this.prisma.pipeline.findMany({
      where: {
        ativo: true,
        tenant_id: user.tenantId,
        ...(includeArchived ? {} : { arquivado: false }),
      },
      include: {
        stages: { orderBy: { ordem: 'asc' } },
        _count: { select: { leads: true } },
      },
      orderBy: { ordem: 'asc' },
    });
  }

  async findOne(id: string, user: AuthUser) {
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      include: {
        stages: {
          orderBy: { ordem: 'asc' },
          include: { _count: { select: { leads: true } } },
        },
      },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');
    return pipeline;
  }

  async create(body: unknown, user: AuthUser) {
    const data = createPipelineSchema.parse(body);
    const count = await this.prisma.pipeline.count({ where: { tenant_id: user.tenantId } });
    return this.prisma.pipeline.create({
      data: {
        nome: data.nome,
        descricao: data.descricao ?? null,
        cor: data.cor ?? '#3b82f6',
        icone: data.icone ?? null,
        ordem: count,
        tenant_id: user.tenantId,
        stages: {
          create: [
            { nome: 'Novo Lead', cor: '#3498DB', ordem: 0, tenant_id: user.tenantId },
            { nome: 'Em Negociacao', cor: '#F39C12', ordem: 1, tenant_id: user.tenantId },
            { nome: 'Fechado', cor: '#27AE60', ordem: 2, is_won: true, tenant_id: user.tenantId },
          ],
        },
      },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
  }

  async update(id: string, body: unknown, user: AuthUser) {
    const data = updatePipelineSchema.parse(body);
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    return this.prisma.pipeline.update({
      where: { id },
      data,
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
  }

  async remove(id: string, user: AuthUser) {
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    const leadsCount = await this.prisma.lead.count({
      where: { pipeline_id: id, tenant_id: user.tenantId },
    });
    if (leadsCount > 0) {
      throw new ConflictException('Nao e possivel excluir: existem leads neste pipeline');
    }
    await this.prisma.pipeline.update({ where: { id }, data: { ativo: false } });
    return { success: true };
  }

  async duplicate(id: string, user: AuthUser) {
    const src = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
    if (!src) throw new NotFoundException('Pipeline nao encontrado');

    const baseName = `${src.nome} (copia)`;
    let finalName = baseName;
    let attempt = 1;
    while (
      await this.prisma.pipeline.findFirst({
        where: { tenant_id: user.tenantId, nome: finalName },
        select: { id: true },
      })
    ) {
      attempt += 1;
      finalName = `${baseName} ${attempt}`;
    }

    const count = await this.prisma.pipeline.count({ where: { tenant_id: user.tenantId } });
    return this.prisma.pipeline.create({
      data: {
        nome: finalName,
        descricao: src.descricao,
        cor: src.cor,
        icone: src.icone,
        ordem: count,
        tenant_id: user.tenantId,
        stages: {
          create: src.stages.map((s) => ({
            nome: s.nome,
            cor: s.cor,
            ordem: s.ordem,
            is_won: s.is_won,
            is_lost: s.is_lost,
            max_dias: s.max_dias,
            auto_action: (s.auto_action ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
            campos_obrigatorios: (s.campos_obrigatorios ?? Prisma.JsonNull) as Prisma.InputJsonValue | typeof Prisma.JsonNull,
            tenant_id: user.tenantId,
          })),
        },
      },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
  }

  async archive(id: string, user: AuthUser) {
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    return this.prisma.pipeline.update({
      where: { id },
      data: { arquivado: true },
    });
  }

  async unarchive(id: string, user: AuthUser) {
    const exists = await this.prisma.pipeline.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Pipeline nao encontrado');
    return this.prisma.pipeline.update({
      where: { id },
      data: { arquivado: false },
    });
  }

  async deleteWithMoveLeads(id: string, body: unknown, user: AuthUser) {
    const { targetPipelineId } = deleteWithMoveSchema.parse(body);
    if (targetPipelineId === id) {
      throw new BadRequestException('Pipeline de destino deve ser diferente do pipeline a excluir');
    }

    const [source, target] = await Promise.all([
      this.prisma.pipeline.findFirst({
        where: { id, tenant_id: user.tenantId },
        select: { id: true },
      }),
      this.prisma.pipeline.findFirst({
        where: { id: targetPipelineId, tenant_id: user.tenantId },
        include: { stages: { orderBy: { ordem: 'asc' }, select: { id: true } } },
      }),
    ]);
    if (!source) throw new NotFoundException('Pipeline de origem nao encontrado');
    if (!target) throw new NotFoundException('Pipeline de destino nao encontrado');
    if (target.stages.length === 0) {
      throw new BadRequestException('Pipeline de destino nao possui etapas');
    }

    const targetFirstStageId = target.stages[0].id;

    await this.prisma.$transaction(async (tx) => {
      await tx.lead.updateMany({
        where: { pipeline_id: id, tenant_id: user.tenantId },
        data: { pipeline_id: targetPipelineId, estagio_id: targetFirstStageId },
      });
      await tx.pipeline.update({
        where: { id },
        data: { ativo: false, arquivado: true },
      });
    });

    await this.invalidateLeadsCache(user.tenantId);
    return { success: true, movedTo: targetPipelineId };
  }

  async reorderPipelines(body: unknown, user: AuthUser) {
    const { pipelineIds } = reorderPipelinesSchema.parse(body);
    const pipelines = await this.prisma.pipeline.findMany({
      where: { tenant_id: user.tenantId },
      select: { id: true },
    });
    const existing = new Set(pipelines.map((p) => p.id));
    if (!pipelineIds.every((pid) => existing.has(pid))) {
      throw new BadRequestException('pipelineIds invalidos para este tenant');
    }
    await this.prisma.$transaction(
      pipelineIds.map((pid, idx) =>
        this.prisma.pipeline.update({ where: { id: pid }, data: { ordem: idx } }),
      ),
    );
    return { success: true };
  }

  async createStage(pipelineId: string, body: unknown, user: AuthUser) {
    const data = createStageSchema.parse(body);
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipelineId, tenant_id: user.tenantId },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');
    const last = await this.prisma.stage.findFirst({
      where: { pipeline_id: pipelineId, tenant_id: user.tenantId },
      orderBy: { ordem: 'desc' },
    });
    const ordem = data.ordem ?? (last ? last.ordem + 1 : 0);
    return this.prisma.stage.create({
      data: {
        nome: data.nome,
        cor: data.cor,
        ordem,
        pipeline_id: pipelineId,
        tenant_id: user.tenantId,
      },
    });
  }

  async updateStage(id: string, body: unknown, user: AuthUser) {
    const data = updateStageSchema.parse(body);
    const exists = await this.prisma.stage.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!exists) throw new NotFoundException('Stage nao encontrada');
    const { auto_action, ...rest } = data;
    const updateData: Prisma.StageUpdateInput = { ...rest };
    if (auto_action !== undefined) {
      updateData.auto_action =
        auto_action === null
          ? Prisma.JsonNull
          : (auto_action as Prisma.InputJsonValue);
    }
    return this.prisma.stage.update({ where: { id }, data: updateData });
  }

  async removeStage(id: string, user: AuthUser) {
    const stage = await this.prisma.stage.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Stage nao encontrada');
    if (stage.is_won || stage.is_lost) {
      throw new ConflictException(
        'Nao e possivel excluir etapas marcadas como ganho ou perda',
      );
    }
    const leadsCount = await this.prisma.lead.count({
      where: { estagio_id: id, tenant_id: user.tenantId },
    });
    if (leadsCount > 0) {
      throw new ConflictException(
        'Nao e possivel excluir: existem leads nesta stage. Mova-os antes de excluir.',
      );
    }
    await this.prisma.stage.delete({ where: { id } });
    return { success: true };
  }

  async reorderStages(pipelineId: string, body: unknown, user: AuthUser) {
    const { stageIds } = reorderStagesSchema.parse(body);
    const stages = await this.prisma.stage.findMany({
      where: { pipeline_id: pipelineId, tenant_id: user.tenantId },
      select: { id: true },
    });
    const existing = new Set(stages.map((s) => s.id));
    if (stageIds.length !== stages.length || !stageIds.every((id) => existing.has(id))) {
      throw new BadRequestException('stageIds invalidos para este pipeline');
    }
    await this.prisma.$transaction(
      stageIds.map((id, idx) =>
        this.prisma.stage.update({ where: { id }, data: { ordem: idx } }),
      ),
    );
    return { success: true };
  }

  async cadenceEligibleCount(stageId: string, stepIndex: number, user: AuthUser) {
    const stage = await this.prisma.stage.findFirst({
      where: { id: stageId, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Etapa não encontrada');

    const config = stage.cadence_config as any;
    const steps: any[] = config?.steps ?? [];
    const step = steps[stepIndex];
    if (!step) return { count: 0 };

    const now = new Date();
    const thresholdMs =
      step.unit === 'MINUTES' ? step.duration * 60_000 :
      step.unit === 'HOURS'   ? step.duration * 3_600_000 :
      /* DAYS */                step.duration * 86_400_000;
    const cutoff = new Date(now.getTime() - thresholdMs);

    const count = await this.prisma.lead.count({
      where: {
        estagio_id: stageId,
        tenant_id: user.tenantId,
        cadence_step_index: stepIndex,
        estagio_entered_at: { lte: cutoff },
      },
    });

    return { count };
  }

  async fireCadenceStep(
    stageId: string,
    stepIndex: number,
    user: AuthUser,
    opts: { batchSize?: number; delayMinSec?: number; delayMaxSec?: number } = {},
  ) {
    const stage = await this.prisma.stage.findFirst({
      where: { id: stageId, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Etapa não encontrada');

    const config = stage.cadence_config as any;
    const steps: any[] = config?.steps ?? [];
    const step = steps[stepIndex];
    if (!step) throw new BadRequestException('Passo de cadência não existe');
    if (!step.template) throw new BadRequestException('Passo sem mensagem definida');

    const now = new Date();
    const thresholdMs =
      step.unit === 'MINUTES' ? step.duration * 60_000 :
      step.unit === 'HOURS'   ? step.duration * 3_600_000 :
      /* DAYS */                step.duration * 86_400_000;
    const cutoff = new Date(now.getTime() - thresholdMs);

    const where: any = {
      estagio_id: stageId,
      tenant_id: user.tenantId,
      cadence_step_index: stepIndex,
      estagio_entered_at: { lte: cutoff },
    };

    // Trava Anti-Robô (manual): só dispara se cliente está sem responder há X tempo
    const lock = step.safety_lock;
    if (lock?.enabled) {
      const lockMs =
        lock.unit === 'MINUTES' ? lock.duration * 60_000 :
        lock.unit === 'HOURS'   ? lock.duration * 3_600_000 :
        /* DAYS */                lock.duration * 86_400_000;
      const lockCutoff = new Date(now.getTime() - lockMs);
      where.OR = [
        { last_customer_message_at: null },
        { last_customer_message_at: { lte: lockCutoff } },
      ];
    }

    const all = await this.prisma.lead.findMany({
      where,
      select: { id: true },
      orderBy: { estagio_entered_at: 'asc' },
    });

    const batch = opts.batchSize && opts.batchSize > 0 ? all.slice(0, opts.batchSize) : all;
    const delayMin = Math.max(0, opts.delayMinSec ?? 0);
    const delayMax = Math.max(delayMin, opts.delayMaxSec ?? 0);

    this.logger.log(`fireCadenceStep: disparando ${batch.length}/${all.length} leads (step ${stepIndex}, delay ${delayMin}-${delayMax}s, user ${user.id})`);

    // Background loop — não bloqueia HTTP. Erros logados, próximos leads continuam.
    void (async () => {
      for (let i = 0; i < batch.length; i++) {
        const lead = batch[i];
        try {
          await this.messages.sendText({ lead_id: lead.id, content: step.template }, user);
          await this.prisma.lead.update({
            where: { id: lead.id },
            data: { cadence_step_index: stepIndex + 1, proximo_followup: null },
          });
          this.logger.debug(`fireCadenceStep: enviado para lead ${lead.id} (${i + 1}/${batch.length})`);
        } catch (err) {
          this.logger.error(`fireCadenceStep: erro no lead ${lead.id}: ${String(err)}`);
        }
        if (i < batch.length - 1 && delayMax > 0) {
          const waitMs = (delayMin + Math.random() * (delayMax - delayMin)) * 1000;
          await new Promise((r) => setTimeout(r, waitMs));
        }
      }
      this.logger.log(`fireCadenceStep: concluído ${batch.length} leads`);
    })();

    return { scheduled: batch.length, totalEligible: all.length };
  }
}
