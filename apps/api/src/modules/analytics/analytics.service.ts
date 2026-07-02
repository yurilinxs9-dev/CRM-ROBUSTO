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

// Datas chegam como 'yyyy-MM-dd' do date-picker. Interpretar em UTC cortava o
// dia brasileiro no meio (leads de hoje sumiam do "Até hoje"): o fim do período
// virava 00:00Z = 21:00 BRT do dia anterior. Ancora o range no fuso do usuário
// (BRT, sem DST desde 2019): from = 00:00-03:00, to = 23:59:59.999-03:00.
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ_OFFSET = '-03:00';

function defaultRange(from?: string, to?: string): { from: Date; to: Date } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const toDate =
    to && dateOnly.test(to)
      ? new Date(`${to}T23:59:59.999${TZ_OFFSET}`)
      : to
        ? new Date(to)
        : new Date();
  const fromDate =
    from && dateOnly.test(from)
      ? new Date(`${from}T00:00:00.000${TZ_OFFSET}`)
      : from
        ? new Date(from)
        : new Date(toDate.getTime() - 30 * DAY_MS);
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

    // Janela anterior de mesmo tamanho, imediatamente antes de `from` — base
    // dos deltas (%) nos KPI cards.
    const windowMs = to.getTime() - from.getTime();
    const prevFrom = new Date(from.getTime() - windowMs);
    const prevTo = new Date(from.getTime() - 1);

    const [snapshot, current, previous] = await Promise.all([
      this.overviewSnapshot(baseWhere),
      this.overviewWindow(baseWhere, from, to),
      this.overviewWindow(baseWhere, prevFrom, prevTo),
    ]);

    const result = {
      period: { from: from.toISOString(), to: to.toISOString() },
      ...snapshot,
      ...current,
      previous,
    };

    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  /** Métricas independentes de período (estado atual do funil). */
  private async overviewSnapshot(baseWhere: Prisma.LeadWhereInput) {
    const [totalLeads, wonAllTime, lostAllTime, totalValueAgg] = await Promise.all([
      this.prisma.lead.count({ where: baseWhere }),
      this.prisma.lead.count({ where: { ...baseWhere, estagio: { is_won: true } } }),
      this.prisma.lead.count({ where: { ...baseWhere, estagio: { is_lost: true } } }),
      this.prisma.lead.aggregate({ where: baseWhere, _sum: { valor_estimado: true } }),
    ]);
    return {
      total_leads: totalLeads,
      open_leads: Math.max(totalLeads - wonAllTime - lostAllTime, 0),
      total_value: Number(toNumber(totalValueAgg._sum.valor_estimado).toFixed(2)),
    };
  }

  /**
   * Métricas de UMA janela de tempo. Ganho/perda no período = lead que ENTROU
   * na etapa won/lost dentro da janela (via estagio_entered_at, 100% populado).
   * Antes, won/lost/conversão eram all-time e trocar 7d↔30d não mudava nada.
   */
  private async overviewWindow(baseWhere: Prisma.LeadWhereInput, from: Date, to: Date) {
    const enteredInWindow = { estagio_entered_at: { gte: from, lte: to } };
    const [newLeads, wonLeads, lostLeads, wonValueAgg] = await Promise.all([
      this.prisma.lead.count({
        where: { ...baseWhere, created_at: { gte: from, lte: to } },
      }),
      this.prisma.lead.count({
        where: { ...baseWhere, estagio: { is_won: true }, ...enteredInWindow },
      }),
      this.prisma.lead.count({
        where: { ...baseWhere, estagio: { is_lost: true }, ...enteredInWindow },
      }),
      this.prisma.lead.aggregate({
        where: { ...baseWhere, estagio: { is_won: true }, ...enteredInWindow },
        _sum: { valor_estimado: true },
      }),
    ]);
    const wonValue = toNumber(wonValueAgg._sum.valor_estimado);
    return {
      new_leads: newLeads,
      won_leads: wonLeads,
      lost_leads: lostLeads,
      won_value: Number(wonValue.toFixed(2)),
      avg_ticket: Number((wonLeads > 0 ? wonValue / wonLeads : 0).toFixed(2)),
      conversion_rate: Number(
        (wonLeads + lostLeads > 0 ? wonLeads / (wonLeads + lostLeads) : 0).toFixed(4),
      ),
    };
  }

  // -------------------------------------------------------------------------
  // A2) Timeseries — evolução diária (novos × ganhos) pro gráfico
  // -------------------------------------------------------------------------

  async getTimeseries(user: AuthUser, query: unknown) {
    const { from: rawFrom, to: rawTo } = dateRangeSchema.parse(query);
    const { from, to } = defaultRange(rawFrom, rawTo);
    const tenantId = user.tenantId;

    const cacheKey = `analytics:timeseries:${tenantId}:${user.role}:${user.id}:${hashFilters({ from, to })}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    const isOperador = user.role === UserRole.OPERADOR;
    const respFilter = isOperador
      ? Prisma.sql`AND l.responsavel_id = ${user.id}`
      : Prisma.empty;

    // Bucket por dia BRASILEIRO: timestamps são UTC-naive no banco; converte
    // pra America/Sao_Paulo antes do date_trunc senão leads da noite caem no
    // dia seguinte.
    const [newRows, wonRows] = await Promise.all([
      this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(date_trunc('day', l.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS n
        FROM "Lead" l
        WHERE l.tenant_id = ${tenantId}
          AND l.created_at >= ${from} AND l.created_at <= ${to}
          ${respFilter}
        GROUP BY 1
      `,
      this.prisma.$queryRaw<{ day: string; n: number }[]>`
        SELECT to_char(date_trunc('day', l.estagio_entered_at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM-DD') AS day,
               COUNT(*)::int AS n
        FROM "Lead" l
        JOIN "Stage" s ON s.id = l.estagio_id
        WHERE l.tenant_id = ${tenantId}
          AND s.is_won = true
          AND l.estagio_entered_at >= ${from} AND l.estagio_entered_at <= ${to}
          ${respFilter}
        GROUP BY 1
      `,
    ]);

    const newMap = new Map(newRows.map((r) => [r.day, Number(r.n)]));
    const wonMap = new Map(wonRows.map((r) => [r.day, Number(r.n)]));

    // Preenche dias sem evento com 0 — gráfico precisa do eixo contínuo.
    // Itera em dias BRT: começa no from (já ancorado 00:00-03:00) e formata
    // cada dia no fuso -03:00.
    const days: Array<{ day: string; new_leads: number; won_leads: number }> = [];
    const brtFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'America/Sao_Paulo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    for (let t = from.getTime(); t <= to.getTime(); t += DAY_MS) {
      const key = brtFmt.format(new Date(t));
      days.push({
        day: key,
        new_leads: newMap.get(key) ?? 0,
        won_leads: wonMap.get(key) ?? 0,
      });
    }

    const result = { period: { from: from.toISOString(), to: to.toISOString() }, days };
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

        // won leads no período (entrou na etapa won dentro da janela — antes
        // era all-time e o filtro 7d/30d não mexia na tabela)
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            estagio: { is_won: true },
            estagio_entered_at: { gte: from, lte: to },
            ...pipelineFilter,
          },
          _count: { id: true },
        }),

        // lost leads no período
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            estagio: { is_lost: true },
            estagio_entered_at: { gte: from, lte: to },
            ...pipelineFilter,
          },
          _count: { id: true },
        }),

        // won value no período
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          orderBy: { responsavel_id: 'asc' },
          where: {
            responsavel_id: { in: userIds },
            tenant_id: tenantId,
            estagio: { is_won: true },
            estagio_entered_at: { gte: from, lte: to },
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
