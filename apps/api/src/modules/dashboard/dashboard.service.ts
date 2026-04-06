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

  async getStats() {
    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - 7);
    const startOfLastWeek = new Date(now);
    startOfLastWeek.setDate(now.getDate() - 14);

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { ativo: true },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });

    const stages: StageRow[] = pipeline?.stages ?? [];

    const stageCounts = await Promise.all(
      stages.map(async (s) => ({
        stageId: s.id,
        nome: s.nome,
        cor: s.cor,
        count: await this.prisma.lead.count({ where: { estagio_id: s.id } }),
      })),
    );

    const totalLeads = await this.prisma.lead.count();
    const leadsThisWeek = await this.prisma.lead.count({
      where: { created_at: { gte: startOfThisWeek } },
    });
    const leadsLastWeek = await this.prisma.lead.count({
      where: { created_at: { gte: startOfLastWeek, lt: startOfThisWeek } },
    });

    const wonStageIds = stages.filter((s: any) => (s as any).is_won).map((s) => s.id);
    const wonCount = wonStageIds.length
      ? await this.prisma.lead.count({ where: { estagio_id: { in: wonStageIds } } })
      : 0;
    const conversionRate = totalLeads > 0 ? Math.round((wonCount / totalLeads) * 100) : 0;

    const tempGroup = await this.prisma.lead.groupBy({
      by: ['temperatura'],
      _count: { id: true },
    });
    const leadsByTemp = tempGroup.map((t) => ({
      temperatura: String(t.temperatura),
      count: t._count.id,
    }));

    const recentLeadActivities = await this.prisma.leadActivity.findMany({
      orderBy: { created_at: 'desc' },
      take: 10,
      include: {
        lead: { select: { nome: true } },
        user: { select: { nome: true } },
      },
    });
    const recentActivity = recentLeadActivities.map((a) => ({
      id: a.id,
      leadNome: a.lead?.nome ?? '',
      action: a.tipo,
      operatorNome: a.user?.nome ?? 'Sistema',
      createdAt: a.created_at,
    }));

    const operatorGroup = await this.prisma.lead.groupBy({
      by: ['responsavel_id'],
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
      take: 5,
    });
    const operatorIds = operatorGroup.map((g) => g.responsavel_id);
    const operators = operatorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: operatorIds } },
          select: { id: true, nome: true },
        })
      : [];
    const topOperators = await Promise.all(
      operatorGroup.map(async (g) => {
        const u = operators.find((o) => o.id === g.responsavel_id);
        const messagesSent = await this.prisma.message.count({
          where: { sent_by_user_id: g.responsavel_id, direction: 'OUTGOING' },
        });
        return {
          id: g.responsavel_id,
          nome: u?.nome ?? 'Desconhecido',
          leadsCount: g._count.id,
          messagesSent,
          avgResponse: 0,
        };
      }),
    );

    return {
      totalLeads,
      leadsThisWeek,
      leadsLastWeek,
      avgResponseMinutes: 0,
      conversionRate,
      leadsByStage: stageCounts,
      leadsByTemp,
      recentActivity,
      topOperators,
    };
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
