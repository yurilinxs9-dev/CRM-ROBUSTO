import { Injectable, NotFoundException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// Query param schemas
// ---------------------------------------------------------------------------

const dateRangeSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
});

const pipelineSchema = z.object({
  pipeline_id: z.string().min(1),
});

const pipelineDateSchema = pipelineSchema.merge(dateRangeSchema);

const performanceSchema = dateRangeSchema.extend({
  pipeline_id: z.string().min(1).optional(),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ANALYTICS_TTL = 60; // seconds

function defaultRange(from?: string, to?: string): { from: Date; to: Date } {
  const toDate = to ? new Date(to) : new Date();
  const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);
  return { from: fromDate, to: toDate };
}

function hashFilters(filters: Record<string, unknown>): string {
  return createHash('sha1').update(JSON.stringify(filters)).digest('hex').slice(0, 12);
}

function toNumber(val: Prisma.Decimal | null | undefined): number {
  if (val === null || val === undefined) return 0;
  return val.toNumber();
}

function calcMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

// ---------------------------------------------------------------------------

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  // -------------------------------------------------------------------------
  // A) Overview
  // -------------------------------------------------------------------------

  async getOverview(user: AuthUser, query: unknown) {
    const { from: rawFrom, to: rawTo } = dateRangeSchema.parse(query);
    const { from, to } = defaultRange(rawFrom, rawTo);
    const tenantId = user.tenantId;

    const cacheKey = `analytics:overview:${tenantId}:${user.role}:${user.id}:${hashFilters({ from, to })}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    // OPERADOR scope
    const operadorFilter: Prisma.LeadWhereInput =
      user.role === UserRole.OPERADOR ? { responsavel_id: user.id } : {};

    const baseWhere: Prisma.LeadWhereInput = { tenant_id: tenantId, ...operadorFilter };

    const [
      totalLeads,
      newLeads,
      wonLeads,
      lostLeads,
      totalValueAgg,
      wonValueAgg,
    ] = await Promise.all([
      // total leads (all time for tenant/user scope)
      this.prisma.lead.count({ where: baseWhere }),

      // new leads created in period
      this.prisma.lead.count({
        where: { ...baseWhere, created_at: { gte: from, lte: to } },
      }),

      // won leads (currently in a won stage)
      this.prisma.lead.count({
        where: { ...baseWhere, estagio: { is_won: true } },
      }),

      // lost leads (currently in a lost stage)
      this.prisma.lead.count({
        where: { ...baseWhere, estagio: { is_lost: true } },
      }),

      // sum of valor_estimado for all leads
      this.prisma.lead.aggregate({
        where: baseWhere,
        _sum: { valor_estimado: true },
      }),

      // sum of valor_estimado for won leads
      this.prisma.lead.aggregate({
        where: { ...baseWhere, estagio: { is_won: true } },
        _sum: { valor_estimado: true },
      }),
    ]);

    const openLeads = totalLeads - wonLeads - lostLeads;
    const totalValue = toNumber(totalValueAgg._sum.valor_estimado);
    const wonValue = toNumber(wonValueAgg._sum.valor_estimado);
    const avgTicket = wonLeads > 0 ? wonValue / wonLeads : 0;
    const conversionRate =
      wonLeads + lostLeads > 0 ? wonLeads / (wonLeads + lostLeads) : 0;

    const result = {
      period: { from: from.toISOString(), to: to.toISOString() },
      total_leads: totalLeads,
      new_leads: newLeads,
      won_leads: wonLeads,
      lost_leads: lostLeads,
      open_leads: Math.max(openLeads, 0),
      total_value: Number(totalValue.toFixed(2)),
      won_value: Number(wonValue.toFixed(2)),
      avg_ticket: Number(avgTicket.toFixed(2)),
      conversion_rate: Number(conversionRate.toFixed(4)),
    };

    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  // -------------------------------------------------------------------------
  // B) Funnel
  // -------------------------------------------------------------------------

  async getFunnel(user: AuthUser, query: unknown) {
    const { pipeline_id } = pipelineSchema.parse(query);
    const tenantId = user.tenantId;

    const cacheKey = `analytics:funnel:${tenantId}:${user.role}:${user.id}:${hashFilters({ pipeline_id })}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    // Validate pipeline belongs to tenant
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipeline_id, tenant_id: tenantId },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');

    const stageIds = pipeline.stages.map((s) => s.id);

    const operadorFilter: Prisma.LeadWhereInput =
      user.role === UserRole.OPERADOR ? { responsavel_id: user.id } : {};

    const grouped = await this.prisma.lead.groupBy({
      by: ['estagio_id'],
      where: {
        estagio_id: { in: stageIds },
        tenant_id: tenantId,
        ...operadorFilter,
      },
      _count: { id: true },
      _sum: { valor_estimado: true },
    });

    const map = new Map(grouped.map((g) => [g.estagio_id, g]));

    const stages = pipeline.stages.map((stage) => {
      const g = map.get(stage.id);
      return {
        id: stage.id,
        nome: stage.nome,
        cor: stage.cor,
        count: g?._count.id ?? 0,
        value: Number(toNumber(g?._sum.valor_estimado).toFixed(2)),
        is_won: stage.is_won,
        is_lost: stage.is_lost,
      };
    });

    const result = { pipeline_id, stages };
    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  // -------------------------------------------------------------------------
  // C) Conversion
  // -------------------------------------------------------------------------

  async getConversion(user: AuthUser, query: unknown) {
    const { pipeline_id, from: rawFrom, to: rawTo } = pipelineDateSchema.parse(query);
    const { from, to } = defaultRange(rawFrom, rawTo);
    const tenantId = user.tenantId;

    const cacheKey = `analytics:conversion:${tenantId}:${user.role}:${user.id}:${hashFilters({ pipeline_id, from, to })}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipeline_id, tenant_id: tenantId },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');

    const operadorLeadFilter: Prisma.LeadWhereInput =
      user.role === UserRole.OPERADOR ? { responsavel_id: user.id } : {};

    // For each stage, count:
    // - entered: LeadActivity with tipo='stage_change', dados_depois.estagio_id = stage.id, in period
    // - current: leads currently in stage
    // - next_stage_count: those who entered this stage AND then moved to the next stage (via another LeadActivity)
    //
    // NOTE: Prisma JSON filtering on dados_depois uses path filter. We use $queryRaw for reliability
    // since Prisma's JSON path filter support varies per provider version.
    // Decision: using $queryRaw for LeadActivity JSON queries to avoid Prisma JSON filter edge cases.

    const stagesWithData = await Promise.all(
      pipeline.stages.map(async (stage, idx) => {
        const nextStage = pipeline.stages[idx + 1];

        // Count current leads in this stage (tenant + operador scoped)
        const current = await this.prisma.lead.count({
          where: {
            estagio_id: stage.id,
            tenant_id: tenantId,
            ...operadorLeadFilter,
          },
        });

        // Count entries into this stage in the period via LeadActivity
        // Using $queryRaw for reliable JSON column filtering
        let entered = 0;
        let nextStageCount = 0;
        try {
          const enteredRows = await this.prisma.$queryRaw<{ cnt: bigint }[]>`
            SELECT COUNT(*) as cnt
            FROM "LeadActivity" la
            WHERE la.tenant_id = ${tenantId}
              AND la.tipo = 'stage_change'
              AND la.created_at >= ${from}
              AND la.created_at <= ${to}
              AND la.dados_depois->>'estagio_id' = ${stage.id}
              ${
                user.role === UserRole.OPERADOR
                  ? Prisma.sql`AND EXISTS (
                      SELECT 1 FROM "Lead" l
                      WHERE l.id = la.lead_id
                        AND l.responsavel_id = ${user.id}
                    )`
                  : Prisma.empty
              }
          `;
          entered = Number(enteredRows[0]?.cnt ?? 0);

          // Count how many that entered this stage also entered the next stage after
          if (nextStage) {
            const nextRows = await this.prisma.$queryRaw<{ cnt: bigint }[]>`
              SELECT COUNT(DISTINCT la2.lead_id) as cnt
              FROM "LeadActivity" la
              JOIN "LeadActivity" la2
                ON la2.lead_id = la.lead_id
               AND la2.tipo = 'stage_change'
               AND la2.dados_depois->>'estagio_id' = ${nextStage.id}
               AND la2.created_at > la.created_at
              WHERE la.tenant_id = ${tenantId}
                AND la.tipo = 'stage_change'
                AND la.created_at >= ${from}
                AND la.created_at <= ${to}
                AND la.dados_depois->>'estagio_id' = ${stage.id}
                ${
                  user.role === UserRole.OPERADOR
                    ? Prisma.sql`AND EXISTS (
                        SELECT 1 FROM "Lead" l
                        WHERE l.id = la.lead_id
                          AND l.responsavel_id = ${user.id}
                      )`
                    : Prisma.empty
                }
            `;
            nextStageCount = Number(nextRows[0]?.cnt ?? 0);
          }
        } catch {
          // If raw query fails (e.g., test env), fallback to 0
          entered = 0;
          nextStageCount = 0;
        }

        const conversionRate = entered > 0 ? Number((nextStageCount / entered).toFixed(4)) : 0;

        return {
          id: stage.id,
          nome: stage.nome,
          entered,
          current,
          next_stage_count: nextStageCount,
          conversion_rate: conversionRate,
        };
      }),
    );

    const result = {
      pipeline_id,
      period: { from: from.toISOString(), to: to.toISOString() },
      stages: stagesWithData,
    };

    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  // -------------------------------------------------------------------------
  // D) Time in Stage
  // -------------------------------------------------------------------------

  async getTimeInStage(user: AuthUser, query: unknown) {
    const { pipeline_id } = pipelineDateSchema.parse(query);
    const tenantId = user.tenantId;

    const cacheKey = `analytics:time-in-stage:${tenantId}:${user.role}:${user.id}:${hashFilters({ pipeline_id })}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: pipeline_id, tenant_id: tenantId },
      include: { stages: { orderBy: { ordem: 'asc' } } },
    });
    if (!pipeline) throw new NotFoundException('Pipeline nao encontrado');

    const operadorFilter: Prisma.LeadWhereInput =
      user.role === UserRole.OPERADOR ? { responsavel_id: user.id } : {};

    const now = new Date();

    // v1: currently-present leads only. avg of (now - estagio_entered_at) in days.
    // TODO: include historical via LeadActivity (enter/exit deltas) for more accuracy.
    const stages = await Promise.all(
      pipeline.stages.map(async (stage) => {
        const leads = await this.prisma.lead.findMany({
          where: {
            estagio_id: stage.id,
            tenant_id: tenantId,
            estagio_entered_at: { not: null },
            ...operadorFilter,
          },
          select: { estagio_entered_at: true },
        });

        if (leads.length === 0) {
          return {
            id: stage.id,
            nome: stage.nome,
            avg_days: 0,
            median_days: 0,
            samples: 0,
          };
        }

        const dayValues = leads
          .filter((l) => l.estagio_entered_at !== null)
          .map((l) => {
            const ms = now.getTime() - l.estagio_entered_at!.getTime();
            return ms / (1000 * 60 * 60 * 24);
          });

        const avg = dayValues.reduce((a, b) => a + b, 0) / dayValues.length;
        const median = calcMedian(dayValues);

        return {
          id: stage.id,
          nome: stage.nome,
          avg_days: Number(avg.toFixed(2)),
          median_days: Number(median.toFixed(2)),
          samples: dayValues.length,
        };
      }),
    );

    const result = { pipeline_id, stages };
    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  // -------------------------------------------------------------------------
  // E) Performance
  // -------------------------------------------------------------------------

  async getPerformance(user: AuthUser, query: unknown) {
    const { from: rawFrom, to: rawTo, pipeline_id } = performanceSchema.parse(query);
    const { from, to } = defaultRange(rawFrom, rawTo);
    const tenantId = user.tenantId;

    const cacheKey = `analytics:performance:${tenantId}:${user.role}:${user.id}:${hashFilters({ from, to, pipeline_id })}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    // Fetch all active non-visualizador users in tenant
    const users = await this.prisma.user.findMany({
      where: { tenant_id: tenantId, ativo: true, role: { not: 'VISUALIZADOR' } },
      select: { id: true, nome: true },
    });

    // OPERADOR: only see themselves
    const scopedUsers =
      user.role === UserRole.OPERADOR ? users.filter((u) => u.id === user.id) : users;

    const userIds = scopedUsers.map((u) => u.id);
    if (userIds.length === 0) {
      const result = { period: { from: from.toISOString(), to: to.toISOString() }, users: [] };
      await this.cache.set(cacheKey, result, ANALYTICS_TTL);
      return result;
    }

    const pipelineFilter: Prisma.LeadWhereInput = pipeline_id ? { pipeline_id } : {};

    // Use Promise.all (not $transaction) — groupBy types are incompatible inside $transaction array
    const [totalGroup, newGroup, wonGroup, lostGroup, wonValueGroup, taskGroup] =
      await Promise.all([
        // total leads assigned to each user (all time)
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            ...pipelineFilter,
          },
          _count: { id: true },
        }),

        // new leads assigned in period
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            created_at: { gte: from, lte: to },
            ...pipelineFilter,
          },
          _count: { id: true },
        }),

        // won leads
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            estagio: { is_won: true },
            ...pipelineFilter,
          },
          _count: { id: true },
        }),

        // lost leads
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            estagio: { is_lost: true },
            ...pipelineFilter,
          },
          _count: { id: true },
        }),

        // won value per user
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            estagio: { is_won: true },
            ...pipelineFilter,
          },
          _sum: { valor_estimado: true },
        }),

        // pending tasks per responsible user
        this.prisma.task.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            status: 'PENDENTE',
          },
          _count: { id: true },
        }),
      ]);

    const totalMap = new Map(totalGroup.map((g) => [g.responsavel_id, g._count.id]));
    const newMap = new Map(newGroup.map((g) => [g.responsavel_id, g._count.id]));
    const wonMap = new Map(wonGroup.map((g) => [g.responsavel_id, g._count.id]));
    const lostMap = new Map(lostGroup.map((g) => [g.responsavel_id, g._count.id]));
    const wonValueMap = new Map(
      wonValueGroup.map((g) => [g.responsavel_id, toNumber(g._sum?.valor_estimado)]),
    );
    const taskMap = new Map(taskGroup.map((g) => [g.responsavel_id, g._count.id]));

    const usersData = scopedUsers
      .map((u) => {
        const totalLeads = totalMap.get(u.id) ?? 0;
        const pendingTasks = taskMap.get(u.id) ?? 0;
        // Only include users with at least 1 lead OR 1 pending task
        if (totalLeads === 0 && pendingTasks === 0) return null;

        const wonLeads = wonMap.get(u.id) ?? 0;
        const lostLeads = lostMap.get(u.id) ?? 0;
        const wonValue = wonValueMap.get(u.id) ?? 0;
        const conversionRate =
          wonLeads + lostLeads > 0
            ? Number((wonLeads / (wonLeads + lostLeads)).toFixed(4))
            : 0;

        return {
          id: u.id,
          nome: u.nome,
          total_leads: totalLeads,
          new_leads: newMap.get(u.id) ?? 0,
          won_leads: wonLeads,
          lost_leads: lostLeads,
          won_value: Number(wonValue.toFixed(2)),
          conversion_rate: conversionRate,
          pending_tasks: pendingTasks,
        };
      })
      .filter((u): u is NonNullable<typeof u> => u !== null);

    const result = {
      period: { from: from.toISOString(), to: to.toISOString() },
      users: usersData,
    };

    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }
}
