import { Injectable, BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { z } from 'zod';

const createPipelineSchema = z.object({
  nome: z.string().min(1).max(100),
  descricao: z.string().max(500).optional().nullable(),
});

const updatePipelineSchema = z.object({
  nome: z.string().min(1).max(100).optional(),
  descricao: z.string().max(500).optional().nullable(),
  ativo: z.boolean().optional(),
});

const createStageSchema = z.object({
  nome: z.string().min(1).max(100),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3498DB'),
  ordem: z.number().int().optional(),
});

const updateStageSchema = z.object({
  nome: z.string().min(1).max(100).optional(),
  cor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  ordem: z.number().int().optional(),
  is_won: z.boolean().optional(),
  is_lost: z.boolean().optional(),
});

const reorderStagesSchema = z.object({
  stageIds: z.array(z.string().uuid()).min(1),
});

@Injectable()
export class PipelinesService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: AuthUser) {
    return this.prisma.pipeline.findMany({
      where: { ativo: true, tenant_id: user.tenantId },
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
    return this.prisma.stage.update({ where: { id }, data });
  }

  async removeStage(id: string, user: AuthUser) {
    const stage = await this.prisma.stage.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!stage) throw new NotFoundException('Stage nao encontrada');
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
}
