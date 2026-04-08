import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import type { AuthUser } from '../../common/types/auth-user';

export interface StageRow { id: string; nome: string; cor: string; ordem: number; is_won?: boolean; }

// Dashboard data changes slowly relative to render frequency — a short TTL
// makes the first hit pay the cost and everyone else gets sub-10ms responses.
const DASHBOARD_TTL_SECONDS = 30;

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private cache: RedisCacheService,
  ) {}

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get<T>(key);
    if (hit !== null) return hit;
    const value = await loader();
    await this.cache.set(key, value, DASHBOARD_TTL_SECONDS);
    return value;
  }

  async getFunnel(user: AuthUser, pipelineId?: string) {
    return this.cached(`dash:funnel:${user.tenantId}:${pipelineId ?? 'active'}`, () =>
      this.computeFunnel(user, pipelineId),
    );
  }

  private async computeFunnel(user: AuthUser, pipelineId?: string) {
    const pipeline = pipelineId
      ? await this.prisma.pipeline.findFirst({
          where: { id: pipelineId, tenant_id: user.tenantId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        })
      : await this.prisma.pipeline.findFirst({
          where: { ativo: true, tenant_id: user.tenantId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        });

    if (!pipeline) return [];

    const stageIds = pipeline.stages.map((s) => s.id);
    const grouped = await this.prisma.lead.groupBy({
      by: ['estagio_id'],
      where: { estagio_id: { in: stageIds }, tenant_id: user.tenantId },
      _count: { id: true },
      _sum: { valor_estimado: true },
    });
    const map = new Map(grouped.map((g) => [g.estagio_id, g]));

    return pipeline.stages.map((stage) => {
      const g = map.get(stage.id);
      return {
        stage: { id: stage.id, nome: stage.nome, cor: stage.cor, ordem: stage.ordem },
        count: g?._count.id ?? 0,
        total: g?._sum.valor_estimado ?? 0,
      };
    });
  }

  async getPerformance(user: AuthUser) {
    return this.cached(`dash:perf:${user.tenantId}`, () => this.computePerformance(user));
  }

  private async computePerformance(user: AuthUser) {
    const users = await this.prisma.user.findMany({
      where: { ativo: true, role: { not: 'VISUALIZADOR' }, tenant_id: user.tenantId },
      select: { id: true, nome: true, avatar_url: true },
    });
    const userIds = users.map((u) => u.id);

    const [leadsGroup, wonGroup, msgsGroup] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['responsavel_id'],
        where: { responsavel_id: { in: userIds }, tenant_id: user.tenantId },
        _count: { id: true },
      }),
      this.prisma.lead.groupBy({
        by: ['responsavel_id'],
        where: {
          responsavel_id: { in: userIds },
          tenant_id: user.tenantId,
          estagio: { is_won: true },
        },
        _count: { id: true },
      }),
      this.prisma.message.groupBy({
        by: ['sent_by_user_id'],
        where: {
          sent_by_user_id: { in: userIds },
          direction: 'OUTGOING',
          tenant_id: user.tenantId,
        },
        _count: { id: true },
      }),
    ]);

    const leadsMap = new Map(leadsGroup.map((g) => [g.responsavel_id, g._count.id]));
    const wonMap = new Map(wonGroup.map((g) => [g.responsavel_id, g._count.id]));
    const msgsMap = new Map(msgsGroup.map((g) => [g.sent_by_user_id, g._count.id]));

    return users.map((u) => ({
      user: u,
      leads_total: leadsMap.get(u.id) ?? 0,
      leads_ganhos: wonMap.get(u.id) ?? 0,
      mensagens_enviadas: msgsMap.get(u.id) ?? 0,
    }));
  }

  async getStats(user: AuthUser) {
    return this.cached(`dash:stats:${user.tenantId}`, () => this.computeStats(user));
  }

  private async computeStats(user: AuthUser) {
    const now = new Date();
    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - 7);
    const startOfLastWeek = new Date(now);
    startOfLastWeek.setDate(now.getDate() - 14);

    // Group ALL tenant leads by their actual estagio_id — the previous
    // implementation filtered by the stages of the "ativo: true" pipeline,
    // so leads sitting in any other pipeline (or with a stale active flag)
    // rendered as zero in the funnel even when totalLeads > 0.
    const [stageGroup, totalLeads, leadsThisWeek, leadsLastWeek, tempGroup, recentLeadActivities, operatorGroup] =
      await Promise.all([
        this.prisma.lead.groupBy({
          by: ['estagio_id'],
          where: { tenant_id: user.tenantId, estagio_id: { not: null } },
          _count: { id: true },
        }),
        this.prisma.lead.count({ where: { tenant_id: user.tenantId } }),
        this.prisma.lead.count({
          where: { created_at: { gte: startOfThisWeek }, tenant_id: user.tenantId },
        }),
        this.prisma.lead.count({
          where: {
            created_at: { gte: startOfLastWeek, lt: startOfThisWeek },
            tenant_id: user.tenantId,
          },
        }),
        this.prisma.lead.groupBy({
          by: ['temperatura'],
          where: { tenant_id: user.tenantId },
          _count: { id: true },
        }),
        this.prisma.leadActivity.findMany({
          where: { tenant_id: user.tenantId },
          orderBy: { created_at: 'desc' },
          take: 10,
          include: {
            lead: { select: { nome: true } },
            user: { select: { nome: true } },
          },
        }),
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          where: { tenant_id: user.tenantId },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 5,
        }),
      ]);

    // Resolve only the stages that actually have leads attached.
    const usedStageIds = stageGroup
      .map((g) => g.estagio_id)
      .filter((id): id is string => !!id);
    const usedStages = usedStageIds.length
      ? ((await this.prisma.stage.findMany({
          where: { id: { in: usedStageIds }, tenant_id: user.tenantId },
          orderBy: { ordem: 'asc' },
        })) as StageRow[])
      : [];

    const stageCountMap = new Map(
      stageGroup.map((g) => [g.estagio_id, g._count.id]),
    );
    const stageCounts = usedStages.map((s) => ({
      stageId: s.id,
      nome: s.nome,
      cor: s.cor,
      count: stageCountMap.get(s.id) ?? 0,
    }));

    const wonStageIds = usedStages.filter((s) => s.is_won).map((s) => s.id);
    const wonCount = wonStageIds.length
      ? stageGroup
          .filter((g) => g.estagio_id && wonStageIds.includes(g.estagio_id))
          .reduce((a, g) => a + g._count.id, 0)
      : 0;
    const conversionRate = totalLeads > 0 ? Math.round((wonCount / totalLeads) * 100) : 0;

    const leadsByTemp = tempGroup.map((t) => ({
      temperatura: String(t.temperatura),
      count: t._count.id,
    }));

    const recentActivity = recentLeadActivities.map((a) => ({
      id: a.id,
      leadNome: a.lead?.nome ?? '',
      action: a.tipo,
      operatorNome: a.user?.nome ?? 'Sistema',
      createdAt: a.created_at,
    }));

    const operatorIds = operatorGroup.map((g) => g.responsavel_id);
    const [operators, msgsByOp] = await Promise.all([
      operatorIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: operatorIds }, tenant_id: user.tenantId },
            select: { id: true, nome: true },
          })
        : Promise.resolve([] as { id: string; nome: string }[]),
      operatorIds.length
        ? this.prisma.message.groupBy({
            by: ['sent_by_user_id'],
            where: {
              sent_by_user_id: { in: operatorIds },
              direction: 'OUTGOING',
              tenant_id: user.tenantId,
            },
            _count: { id: true },
          })
        : Promise.resolve([] as { sent_by_user_id: string | null; _count: { id: number } }[]),
    ]);
    const msgsMap = new Map(msgsByOp.map((m) => [m.sent_by_user_id, m._count.id]));
    const topOperators = operatorGroup.map((g) => {
      const u = operators.find((o) => o.id === g.responsavel_id);
      return {
        id: g.responsavel_id,
        nome: u?.nome ?? 'Desconhecido',
        leadsCount: g._count.id,
        messagesSent: msgsMap.get(g.responsavel_id) ?? 0,
        avgResponse: 0,
      };
    });

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

  async getVolume(user: AuthUser) {
    return this.cached(`dash:volume:${user.tenantId}`, () => this.computeVolume(user));
  }

  private async computeVolume(user: AuthUser) {
    const last7days = new Date();
    last7days.setDate(last7days.getDate() - 7);

    return this.prisma.message.groupBy({
      by: ['created_at'],
      where: { created_at: { gte: last7days }, tenant_id: user.tenantId },
      _count: { id: true },
      orderBy: { created_at: 'asc' },
    });
  }
}
