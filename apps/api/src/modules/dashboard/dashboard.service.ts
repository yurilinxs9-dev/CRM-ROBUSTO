import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

export interface StageRow { id: string; nome: string; cor: string; ordem: number; }
export interface UserRow { id: string; nome: string; avatar_url: string | null; }

@Injectable()
export class DashboardService {
  constructor(private prisma: PrismaService) {}

  async getFunnel(pipelineId?: string) {
    const pipeline = pipelineId
      ? await this.prisma.pipeline.findUnique({
          where: { id: pipelineId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        })
      : await this.prisma.pipeline.findFirst({
          where: { ativo: true },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        });

    if (!pipeline) return [];

    return Promise.all(
      pipeline.stages.map(async (stage: StageRow) => {
        const leads = await this.prisma.lead.aggregate({
          where: { estagio_id: stage.id },
          _count: { id: true },
          _sum: { valor_estimado: true },
        });
        return {
          stage: { id: stage.id, nome: stage.nome, cor: stage.cor, ordem: stage.ordem },
          count: leads._count.id,
          total: leads._sum.valor_estimado || 0,
        };
      }),
    );
  }

  async getPerformance() {
    const users = await this.prisma.user.findMany({
      where: { ativo: true, role: { not: 'VISUALIZADOR' } },
      select: { id: true, nome: true, avatar_url: true },
    });

    return Promise.all(
      users.map(async (user: UserRow) => {
        const leads = await this.prisma.lead.count({ where: { responsavel_id: user.id } });
        const ganhos = await this.prisma.lead.count({
          where: { responsavel_id: user.id, estagio: { is_won: true } },
        });
        const mensagens = await this.prisma.message.count({
          where: { sent_by_user_id: user.id, direction: 'OUTGOING' },
        });
        return {
          user,
          leads_total: leads,
          leads_ganhos: ganhos,
          mensagens_enviadas: mensagens,
        };
      }),
    );
  }

  async getVolume() {
    const last7days = new Date();
    last7days.setDate(last7days.getDate() - 7);

    return this.prisma.message.groupBy({
      by: ['created_at'],
      where: { created_at: { gte: last7days } },
      _count: { id: true },
      orderBy: { created_at: 'asc' },
    });
  }
}
