import { Prisma } from '@prisma/client';
import { AnalyticsService } from './analytics.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { RedisCacheService } from '../../common/cache/redis-cache.service';
import type { AuthUser } from '../../common/types/auth-user';
import { PL_PIPELINE, PL_TENANT } from '../pl-sales/pl-sales.domain';

const seller: AuthUser = {
  id: 'seller', tenantId: PL_TENANT, role: 'OPERADOR', plSalesOnly: true,
  nome: 'Comercial PL', email: 'seller@example.test', ativo: true,
};
const query = { from: '2026-10-01', to: '2026-10-19', pipeline_id: 'partners', owner_id: 'colleague', responsavel_id: 'colleague' };
const endpoints = ['getOverview', 'getTimeseries', 'getFirstResponse', 'getFunnel', 'getConversion', 'getTimeInStage', 'getPerformance', 'getForecast'] as const;
const pipelineEndpoints = ['getFunnel', 'getConversion', 'getTimeInStage', 'getForecast'] as const;
const leadScope = { tenant_id: PL_TENANT, pipeline_id: PL_PIPELINE, responsavel_id: seller.id };

function setup() {
  const stages = [
    { id: 'open', nome: 'Contato', cor: '#fff', is_won: false, is_lost: false },
    { id: 'won', nome: 'Ganho', cor: '#fff', is_won: true, is_lost: false },
  ];
  const prisma = {
    lead: {
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { valor_estimado: new Prisma.Decimal(0) } }),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
    },
    pipeline: { findFirst: jest.fn().mockResolvedValue({ id: PL_PIPELINE, stages }) },
    tenant: { findUnique: jest.fn().mockResolvedValue({ kanban_individual: false }) },
    stage: { findFirst: jest.fn().mockResolvedValue(null) },
    user: { findMany: jest.fn().mockResolvedValue([{ id: seller.id, nome: seller.nome }]) },
    task: { groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const cache = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined) };
  const service = new AnalyticsService(prisma as unknown as PrismaService, cache as unknown as RedisCacheService);
  return { prisma, cache, service };
}

function sqlCalls(mock: jest.Mock): Prisma.Sql[] {
  return mock.mock.calls.map(([first, ...values]: [Prisma.Sql | TemplateStringsArray, ...unknown[]]) =>
    'sql' in first ? first : Prisma.sql(first, ...values));
}

function setupBoard(individual: boolean, hasOwn = true) {
  const context = setup();
  const { prisma } = context;
  prisma.tenant.findUnique.mockResolvedValue({ kanban_individual: individual });
  prisma.stage.findFirst.mockResolvedValue(hasOwn ? { id: 'own-new' } : null);
  const stages = [
    { id: 'base-new', user_id: null, nome: 'Novo', ordem: 0 },
    ...(hasOwn ? [{ id: 'own-new', user_id: seller.id, nome: 'Novo', ordem: 0 }] : []),
    { id: 'base-contact', user_id: null, nome: 'Contato', ordem: 1 },
    ...(hasOwn ? [{ id: 'own-contact', user_id: seller.id, nome: 'Contato', ordem: 1 }] : []),
    { id: 'colleague-contact', user_id: 'colleague', nome: 'Colleague stage', ordem: 1 },
  ].map((stage) => ({ ...stage, cor: '#fff', is_won: false, is_lost: false }));
  // Model the stage filter at the database boundary so mixed-board queries
  // reproduce the incorrect adjacency, instead of returning a prefiltered mock.
  prisma.pipeline.findFirst.mockImplementation(async (args: { include: { stages: Prisma.StageFindManyArgs } }) => {
    const where = args.include.stages.where;
    return { id: PL_PIPELINE, stages: stages.filter((stage) => {
      if (!where) return true;
      if ('user_id' in where && stage.user_id !== where.user_id) return false;
      return !Array.isArray(where.OR) || where.OR.some((filter) => stage.user_id === filter.user_id);
    }) };
  });
  return context;
}

describe('restricted PL analytics', () => {
  it.each(endpoints)('%s never reads or writes reports cached before a transfer or profile change', async (endpoint) => {
    const { service, cache } = setup();
    cache.get.mockResolvedValue({ colleague: 'Cached team data' });
    const result = await service[endpoint](seller, query);
    expect(result).not.toEqual({ colleague: 'Cached team data' });
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it.each(endpoints)('%s preserves ordinary profile cache behavior', async (endpoint) => {
    const { service, cache, prisma } = setup();
    cache.get.mockResolvedValue({ existing: true });
    expect(await service[endpoint]({ ...seller, plSalesOnly: false }, query)).toEqual({ existing: true });
    expect(cache.get).toHaveBeenCalledTimes(1);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it.each(pipelineEndpoints)('%s ignores spoofed pipelines and uses base stages when individual boards are disabled', async (endpoint) => {
    const { service, prisma } = setup();
    await service[endpoint](seller, query);
    expect(prisma.pipeline.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: PL_PIPELINE, tenant_id: PL_TENANT },
      include: { stages: { orderBy: { ordem: 'asc' }, where: {
        tenant_id: PL_TENANT, user_id: null,
      } } },
    }));
    for (const mock of [prisma.lead.count, prisma.lead.aggregate, prisma.lead.groupBy]) {
      for (const [args] of mock.mock.calls) expect(args.where).toEqual(expect.objectContaining(leadScope));
    }
  });

  it.each(pipelineEndpoints)('%s selects only the personal board when individual boards are enabled and own stages exist', async (endpoint) => {
    const { service, prisma } = setupBoard(true);
    const result = await service[endpoint](seller, query) as { stages: { id: string }[] };
    expect(result.stages.map((stage) => stage.id)).toEqual(['own-new', 'own-contact']);
    expect(prisma.stage.findFirst).toHaveBeenCalledWith({
      where: { tenant_id: PL_TENANT, pipeline_id: PL_PIPELINE, user_id: seller.id }, select: { id: true },
    });
  });

  it.each(pipelineEndpoints)('%s uses the personal PL board even when the workspace toggle is off', async (endpoint) => {
    const { service, prisma } = setupBoard(false);
    const result = await service[endpoint](seller, query) as { stages: { id: string }[] };
    expect(result.stages.map((stage) => stage.id)).toEqual(['own-new', 'own-contact']);
    expect(prisma.stage.findFirst).toHaveBeenCalled();
  });

  it.each(pipelineEndpoints)('%s falls back to the base board when individual mode has no own stages yet', async (endpoint) => {
    const { service } = setupBoard(true, false);
    const result = await service[endpoint](seller, query) as { stages: { id: string }[] };
    expect(result.stages.map((stage) => stage.id)).toEqual(['base-new', 'base-contact']);
  });

  it('conversion follows own Novo -> own Contato despite interleaved base stage ordering', async () => {
    const { service, prisma } = setupBoard(true);
    await service.getConversion(seller, query);
    const transitions = sqlCalls(prisma.$queryRaw).filter((sql) => sql.text.includes('JOIN "LeadActivity" la2'));
    const fromNovo = transitions.find((sql) => {
      const currentStageParameter = sql.text.match(/la\.dados_depois->>'estagio_id' = \$(\d+)/);
      return currentStageParameter !== null && sql.values[Number(currentStageParameter[1]) - 1] === 'own-new';
    });
    expect(fromNovo).toBeDefined();
    const nextStageParameter = fromNovo!.text.match(/la2\.dados_depois->>'estagio_id' = \$(\d+)/);
    expect(nextStageParameter).not.toBeNull();
    expect(fromNovo!.values[Number(nextStageParameter![1]) - 1]).toBe('own-contact');
    expect(transitions).toHaveLength(1);
  });

  it('management conversion never treats a different personal board as the next stage', async () => {
    const { service, prisma } = setupBoard(false);
    await service.getConversion({ ...seller, role: 'SUPER_ADMIN', plSalesOnly: false }, { ...query, pipeline_id: PL_PIPELINE });
    const transitions = sqlCalls(prisma.$queryRaw).filter(sql => sql.text.includes('JOIN "LeadActivity" la2'));
    const pairs = transitions.map(sql => {
      const from = sql.text.match(/la\.dados_depois->>'estagio_id' = \$(\d+)/)!;
      const to = sql.text.match(/la2\.dados_depois->>'estagio_id' = \$(\d+)/)!;
      return [sql.values[Number(from[1]) - 1], sql.values[Number(to[1]) - 1]];
    });
    expect(pairs).toEqual(expect.arrayContaining([['base-new', 'base-contact'], ['own-new', 'own-contact']]));
    expect(pairs).toHaveLength(2);
  });

  it('overview scopes all current/previous counts and explicitly identifies lead estimates', async () => {
    const { service, prisma } = setup();
    expect(await service.getOverview(seller, query)).toEqual(expect.objectContaining({ value_basis: 'lead_estimate' }));
    for (const mock of [prisma.lead.count, prisma.lead.aggregate]) {
      for (const [args] of mock.mock.calls) expect(args.where).toEqual(expect.objectContaining(leadScope));
    }
    expect(prisma.lead.count).toHaveBeenCalledWith({ where: expect.objectContaining({
      created_at: { gte: new Date('2026-10-01T03:00:00Z'), lte: new Date('2026-10-20T02:59:59.999Z') },
    }) });
  });

  it('timeseries constrains both raw aggregations and preserves BRT daily buckets for weekly/monthly totals', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValueOnce([{ day: '2026-10-01', n: 2 }]).mockResolvedValueOnce([]);
    const result = await service.getTimeseries(seller, query) as { days: { day: string; new_leads: number }[] };
    expect(result.days).toHaveLength(19);
    expect(result.days[0]).toEqual({ day: '2026-10-01', new_leads: 2, won_leads: 0 });
    for (const sql of sqlCalls(prisma.$queryRaw)) {
      expect(sql.values).toEqual(expect.arrayContaining([PL_TENANT, PL_PIPELINE, seller.id]));
      expect(sql.text).toMatch(/l\.responsavel_id = \$\d+/);
      expect(sql.text).toMatch(/l\.pipeline_id = \$\d+/);
    }
  });

  it('conversion raw activity queries join only the currently owned PL leads, including the second event tenant', async () => {
    const { service, prisma } = setup();
    await service.getConversion(seller, query);
    const calls = sqlCalls(prisma.$queryRaw);
    expect(calls).toHaveLength(3);
    for (const sql of calls) {
      expect(sql.values).toEqual(expect.arrayContaining([PL_TENANT, PL_PIPELINE, seller.id]));
      expect(sql.text).toMatch(/l\.tenant_id = \$\d+/);
      expect(sql.text).toMatch(/l\.pipeline_id = \$\d+/);
      expect(sql.text).toMatch(/l\.responsavel_id = \$\d+/);
    }
    expect(calls.find((sql) => sql.text.includes('JOIN "LeadActivity" la2'))?.text).toMatch(/la2\.tenant_id = la\.tenant_id/);
  });

  it('forecast history and fallback rates cannot incorporate colleagues or partner leads', async () => {
    const { service, prisma } = setup();
    await service.getForecast(seller, query);
    const [sql] = sqlCalls(prisma.$queryRaw);
    expect(sql.values).toEqual(expect.arrayContaining([PL_TENANT, PL_PIPELINE, seller.id]));
    expect(sql.text).toMatch(/l\.responsavel_id = \$\d+/);
    expect(sql.text).toMatch(/la\.tenant_id =/);
    for (const [args] of prisma.lead.count.mock.calls) expect(args.where).toEqual(expect.objectContaining(leadScope));
  });

  it('time in stage aggregates in SQL instead of fetching the whole portfolio', async () => {
    const { service, prisma } = setup();
    prisma.$queryRaw.mockResolvedValue([{ estagio_id: 'open', avg_days: 4, median_days: 2, samples: 3 }]);
    const result = await service.getTimeInStage(seller, query) as { stages: unknown[] };
    expect(result.stages[0]).toEqual({ id: 'open', nome: 'Contato', avg_days: 4, median_days: 2, samples: 3 });
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
    const [sql] = sqlCalls(prisma.$queryRaw);
    expect(sql.values).toEqual(expect.arrayContaining([PL_TENANT, PL_PIPELINE, seller.id]));
    expect(sql.text).toMatch(/percentile_cont/i);
    expect(sql.text).toMatch(/GROUP BY l\.estagio_id/);
  });

  it('performance queries only her identity, PL leads and pending tasks still attached to her PL leads', async () => {
    const { service, prisma } = setup();
    await service.getPerformance(seller, query);
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenant_id: PL_TENANT, id: seller.id }) }));
    for (const [args] of prisma.lead.groupBy.mock.calls) expect(args.where).toEqual(expect.objectContaining(leadScope));
    expect(prisma.task.groupBy).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({
      tenant_id: PL_TENANT, responsavel_id: { in: [seller.id] }, lead: leadScope,
    }) }));
  });

  it('first response uses only sent replies by this seller after assignment, and returns aggregate average separately from median', async () => {
    const { service, prisma } = setup();
    // Three replies taking 60, 60, 300 seconds; one unanswered conversation.
    prisma.$queryRaw.mockResolvedValue([{ total_conversations: 4, samples: 3, average_seconds: 140, median_seconds: 60 }]);
    expect(await service.getFirstResponse(seller, query)).toEqual({
      period: { from: '2026-10-01T03:00:00.000Z', to: '2026-10-20T02:59:59.999Z' },
      total_conversations: 4, unanswered: 1, average_seconds: 140, samples: 3,
      users: [{ id: seller.id, nome: seller.nome, answered: 3, avg_seconds: 140, median_seconds: 60 }],
    });
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    const [sql] = sqlCalls(prisma.$queryRaw);
    expect(sql.values).toEqual(expect.arrayContaining([PL_TENANT, PL_PIPELINE, seller.id]));
    expect(sql.text).toMatch(/l\.responsavel_id = \$\d+/);
    expect(sql.text).toMatch(/reply\.sent_by_user_id = \$\d+/);
    expect(sql.text).toMatch(/reply\.status IN \('SENT', 'DELIVERED', 'READ'\)/);
    expect(sql.text).toMatch(/l\.assumed_at/);
    expect(sql.text).toMatch(/dados_depois->>'responsavel_id'/);
    expect(sql.text).toMatch(/clock\.started_at >=/);
    expect(sql.text).toMatch(/reply\.created_at <=/);
    expect(sql.text).toMatch(/percentile_cont/i);
    expect(sql.text).toMatch(/AVG\(/);
    expect(sql.text).toMatch(/incoming\.tenant_id = l\.tenant_id/);
    expect(sql.text).toMatch(/reply\.tenant_id = l\.tenant_id/);
  });

  it('first response reports no samples truthfully without synthesizing a zero-minute response', async () => {
    const { service, prisma } = setup();
    expect(await service.getFirstResponse(seller, query)).toEqual(expect.objectContaining({
      total_conversations: 0, unanswered: 0, average_seconds: null, samples: 0, users: [],
    }));
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('ordinary managers retain requested pipeline and team scope', async () => {
    const { service, prisma, cache } = setup();
    await service.getFunnel({ ...seller, role: 'GERENTE' }, query);
    expect(prisma.pipeline.findFirst).toHaveBeenCalledWith({ where: { id: 'partners', tenant_id: PL_TENANT }, include: { stages: { orderBy: { ordem: 'asc' } } } });
    expect(prisma.lead.groupBy.mock.calls[0][0].where.responsavel_id).toBeUndefined();
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.stage.findFirst).not.toHaveBeenCalled();
    expect(cache.set).toHaveBeenCalledTimes(1);
  });
});
