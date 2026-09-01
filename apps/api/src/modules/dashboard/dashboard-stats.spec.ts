import { DashboardService } from './dashboard.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * `GET /dashboard/stats` — o painel que TODO usuario abre. Dois bugs de leitura
 * moravam aqui, os dois entregando numero plausivel (o pior tipo):
 *
 * 1. ESCOPO. Toda contagem filtrava so por `tenant_id`: o operador via os 2.448
 *    leads da loja em vez dos 552 dele — e via nome de lead dos colegas na
 *    atividade recente. O recorte tem que ser o MESMO do resto do sistema
 *    (`buildVisibilityWhere`), senao o dashboard vira uma porta lateral pro
 *    board que o Kanban fecha.
 * 2. FUNIL FRAGMENTADO. Com `kanban_individual` cada membro tem clone proprio de
 *    cada coluna (`Stage.user_id`), entao o funil do gestor mostrava "Novo" seis
 *    vezes, uma por dono, cada uma com um pedaco da contagem.
 */

const TENANT = 'tenant-1';
const EU = 'u-eu';

function usuario(role: UserRole, id = EU): AuthUser {
  return {
    id,
    nome: 'Fulano',
    email: 'f@x.com',
    role: role as never,
    ativo: true,
    tenantId: TENANT,
  };
}

const OPERADOR = usuario(UserRole.OPERADOR);
const GERENTE = usuario(UserRole.GERENTE);

interface StageStub {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  is_won: boolean;
  user_id: string | null;
  pipeline_id: string;
}

function coluna(over: Partial<StageStub> & { id: string; nome: string; ordem: number }): StageStub {
  return { cor: '#3498DB', is_won: false, user_id: null, pipeline_id: 'p-1', ...over };
}

const COLUNAS_BASE: StageStub[] = [
  coluna({ id: 's-novo', nome: 'Novo', ordem: 0 }),
  coluna({ id: 's-ganho', nome: 'Ganho', ordem: 1, is_won: true }),
];

interface GrupoContagem {
  chave: string | null;
  count: number;
}

interface MontarStatsOpts {
  poolEnabled?: boolean;
  kanbanIndividual?: boolean;
  focusMode?: boolean;
  stages?: StageStub[];
  porEstagio?: GrupoContagem[];
  porResponsavel?: GrupoContagem[];
  total?: number;
  tarefasPendentes?: number;
  operadores?: Array<{ id: string; nome: string }>;
}

type Where = Record<string, unknown>;

function montarStats(opts: MontarStatsOpts = {}) {
  const stages = opts.stages ?? COLUNAS_BASE;
  const porEstagio = opts.porEstagio ?? [{ chave: 's-novo', count: 1 }];
  const porResponsavel = opts.porResponsavel ?? [{ chave: EU, count: 1 }];

  const leadGroupBy = jest.fn().mockImplementation((args: { by: string[] }) => {
    const campo = args.by[0];
    if (campo === 'estagio_id') {
      return Promise.resolve(
        porEstagio.map((g) => ({ estagio_id: g.chave, _count: { id: g.count } })),
      );
    }
    if (campo === 'responsavel_id') {
      return Promise.resolve(
        porResponsavel.map((g) => ({ responsavel_id: g.chave, _count: { id: g.count } })),
      );
    }
    return Promise.resolve([{ temperatura: 'MORNO', _count: { id: 1 } }]);
  });

  const leadCount = jest.fn().mockImplementation((args: { where: Where }) => {
    const where = args.where;
    if (where.mensagens_nao_lidas) return Promise.resolve(3);
    const criado = where.created_at as { gte?: Date; lt?: Date } | undefined;
    if (criado?.lt) return Promise.resolve(2);
    if (criado?.gte) return Promise.resolve(5);
    return Promise.resolve(opts.total ?? 10);
  });

  const leadFindMany = jest.fn().mockImplementation((args: { select?: Record<string, unknown> }) => {
    // Duas leituras de Lead sobrevivem no metodo: a serie de 14 dias (so
    // `created_at`) e a amostra de tempo de resposta.
    if (args.select?.created_at) return Promise.resolve([]);
    return Promise.resolve([]);
  });

  const prisma = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        pool_enabled: opts.poolEnabled ?? false,
        kanban_individual: opts.kanbanIndividual ?? false,
      }),
    },
    user: {
      findUnique: jest.fn().mockResolvedValue({ focus_mode: opts.focusMode ?? false }),
      findMany: jest.fn().mockResolvedValue(opts.operadores ?? [{ id: EU, nome: 'Fulano' }]),
    },
    lead: {
      groupBy: leadGroupBy,
      count: leadCount,
      findMany: leadFindMany,
      aggregate: jest.fn().mockResolvedValue({ _sum: { valor_estimado: null } }),
    },
    leadActivity: { findMany: jest.fn().mockResolvedValue([]) },
    stage: { findMany: jest.fn().mockResolvedValue(stages) },
    task: { count: jest.fn().mockResolvedValue(opts.tarefasPendentes ?? 0) },
    message: { groupBy: jest.fn().mockResolvedValue([]) },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };

  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  return { service: new DashboardService(prisma as never, cache as never), prisma, cache };
}

/** `where` da primeira chamada de groupBy pelo campo pedido. */
function whereDoGroupBy(prisma: { lead: { groupBy: jest.Mock } }, campo: string): Where {
  const call = prisma.lead.groupBy.mock.calls.find(
    (c: unknown[]) => (c[0] as { by: string[] }).by[0] === campo,
  );
  return (call?.[0] as { where: Where }).where;
}

/** `where` do count sem `created_at` nem `mensagens_nao_lidas` = totalLeads. */
function whereDoTotal(prisma: { lead: { count: jest.Mock } }): Where {
  const call = prisma.lead.count.mock.calls.find((c: unknown[]) => {
    const w = (c[0] as { where: Where }).where;
    return !w.created_at && !w.mensagens_nao_lidas;
  });
  return (call?.[0] as { where: Where }).where;
}

const NUVEM_DEVOLVIDOS = {
  responsavel_id: null,
  returned_at: { not: null },
  is_private: false,
};

describe('DashboardService.getStats — escopo do usuario', () => {
  it('operador conta so a propria carteira mais a nuvem de devolvidos', async () => {
    const { service, prisma } = montarStats();

    await service.getStats(OPERADOR);

    const where = whereDoTotal(prisma);
    expect(where.tenant_id).toBe(TENANT);
    expect(where.OR).toEqual([{ responsavel_id: EU }, NUVEM_DEVOLVIDOS]);
  });

  it('o mesmo recorte vale para semana, temperatura e funil', async () => {
    const { service, prisma } = montarStats();

    await service.getStats(OPERADOR);

    const esperado = [{ responsavel_id: EU }, NUVEM_DEVOLVIDOS];
    expect(whereDoGroupBy(prisma, 'estagio_id').OR).toEqual(esperado);
    expect(whereDoGroupBy(prisma, 'temperatura').OR).toEqual(esperado);
    const semanas = prisma.lead.count.mock.calls
      .map((c: unknown[]) => (c[0] as { where: Where }).where)
      .filter((w: Where) => !!w.created_at);
    expect(semanas).toHaveLength(2);
    for (const w of semanas) expect(w.OR).toEqual(esperado);
  });

  it('gerente supervisionando segue vendo a loja (menos privado alheio)', async () => {
    const { service, prisma } = montarStats();

    await service.getStats(GERENTE);

    const where = whereDoTotal(prisma);
    expect(where.tenant_id).toBe(TENANT);
    expect(where.OR).toEqual([{ is_private: false }, { responsavel_id: EU }]);
  });

  it('gerente em modo foco enxerga como operador (mais os sem dono)', async () => {
    const { service, prisma } = montarStats({ focusMode: true });

    await service.getStats(GERENTE);

    expect(whereDoTotal(prisma).OR).toEqual([
      { responsavel_id: EU },
      { responsavel_id: null, is_private: false },
    ]);
  });

  it('modo compartilhado usa a regra do pool, nao a nuvem de devolvidos', async () => {
    const { service, prisma } = montarStats({ poolEnabled: true });

    await service.getStats(OPERADOR);

    expect(whereDoTotal(prisma).OR).toEqual([
      { responsavel_id: null, is_private: false },
      { responsavel_id: EU },
    ]);
  });

  it('atividade recente sai recortada pelo lead visivel', async () => {
    const { service, prisma } = montarStats();

    await service.getStats(OPERADOR);

    const where = prisma.leadActivity.findMany.mock.calls[0][0].where as {
      tenant_id: string;
      lead: Where;
    };
    expect(where.tenant_id).toBe(TENANT);
    expect(where.lead.OR).toEqual([{ responsavel_id: EU }, NUVEM_DEVOLVIDOS]);
  });

  it('conversas abertas e valor ganho tambem respeitam o recorte', async () => {
    const { service, prisma } = montarStats();

    await service.getStats(OPERADOR);

    const abertas = prisma.lead.count.mock.calls
      .map((c: unknown[]) => (c[0] as { where: Where }).where)
      .find((w: Where) => !!w.mensagens_nao_lidas);
    expect(abertas?.OR).toEqual([{ responsavel_id: EU }, NUVEM_DEVOLVIDOS]);
    const ganho = prisma.lead.aggregate.mock.calls[0][0].where as Where;
    expect(ganho.OR).toEqual([{ responsavel_id: EU }, NUVEM_DEVOLVIDOS]);
  });

  it('tarefas pendentes do operador sao as dele, do gerente sao as do time', async () => {
    const escopado = montarStats();
    await escopado.service.getStats(OPERADOR);
    expect(escopado.prisma.task.count.mock.calls[0][0].where).toMatchObject({
      tenant_id: TENANT,
      responsavel_id: EU,
    });

    const gestao = montarStats();
    await gestao.service.getStats(GERENTE);
    expect(gestao.prisma.task.count.mock.calls[0][0].where.responsavel_id).toBeUndefined();
  });

  /**
   * A serie de 14 dias era SQL cru filtrando so por tenant — o unico jeito de
   * ela respeitar a visibilidade sem duplicar a regra em SQL e ler pelo Prisma
   * com o mesmo `where` das outras contagens.
   */
  it('a tendencia de 14 dias usa o mesmo where, nao SQL cru por tenant', async () => {
    const { service, prisma } = montarStats();

    const r = await service.getStats(OPERADOR);

    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    const serie = prisma.lead.findMany.mock.calls
      .map((c: unknown[]) => c[0] as { where: Where; select: Record<string, unknown> })
      .find((a) => a.select?.created_at === true);
    expect(serie?.where.OR).toEqual([{ responsavel_id: EU }, NUVEM_DEVOLVIDOS]);
    expect(r.leadsTrend).toHaveLength(14);
  });

  it('ranking do gestor segue tenant-wide, com os 5 maiores', async () => {
    const { service, prisma } = montarStats({
      porResponsavel: [
        { chave: 'u-a', count: 40 },
        { chave: 'u-b', count: 10 },
      ],
      operadores: [
        { id: 'u-a', nome: 'Ana' },
        { id: 'u-b', nome: 'Bruno' },
      ],
    });

    const r = await service.getStats(GERENTE);

    expect(prisma.lead.groupBy.mock.calls.some((c: unknown[]) => {
      const a = c[0] as { by: string[]; take?: number };
      return a.by[0] === 'responsavel_id' && a.take === 5;
    })).toBe(true);
    expect(r.topOperators.map((o) => o.nome)).toEqual(['Ana', 'Bruno']);
  });

  /**
   * Escopado, o groupBy por responsavel so pode devolver o proprio usuario e a
   * nuvem (sem dono). A nuvem viraria uma linha "Desconhecido" liderando o
   * ranking do operador — ranking e visao de gestao, nao de fila sem dono.
   */
  it('operador nao ganha linha de "Desconhecido" da nuvem no ranking', async () => {
    const { service } = montarStats({
      porResponsavel: [
        { chave: null, count: 99 },
        { chave: EU, count: 7 },
      ],
    });

    const r = await service.getStats(OPERADOR);

    expect(r.topOperators.map((o) => o.id)).toEqual([EU]);
    expect(r.topOperators[0].leadsCount).toBe(7);
  });

  /**
   * A nuvem (leads sem dono) tambem chega no groupBy do GESTOR, e la ela lidera
   * o ranking como "Desconhecido" — uma fila nao e um operador, e ainda rouba
   * uma das 5 vagas de gente de verdade.
   */
  it('a nuvem sem dono nao vira linha no ranking do gestor', async () => {
    const { service } = montarStats({
      porResponsavel: [
        { chave: null, count: 99 },
        { chave: 'u-a', count: 7 },
      ],
      operadores: [{ id: 'u-a', nome: 'Ana' }],
    });

    const r = await service.getStats(GERENTE);

    expect(r.topOperators.map((o) => o.id)).toEqual(['u-a']);
    expect(r.topOperators.map((o) => o.nome)).not.toContain('Desconhecido');
  });

  it('cache separa por usuario: dois operadores nao dividem o mesmo numero', async () => {
    const { service, cache } = montarStats();

    await service.getStats(OPERADOR);

    const chave = cache.get.mock.calls[0][0] as string;
    expect(chave).toContain(TENANT);
    expect(chave).toContain(EU);
    expect(cache.set.mock.calls[0][0]).toBe(chave);
  });

  it('resposta ja em cache nao consulta o banco', async () => {
    const { service, prisma, cache } = montarStats();
    cache.get.mockResolvedValue({ totalLeads: 7 });

    const r = await service.getStats(OPERADOR);

    expect(r).toEqual({ totalLeads: 7 });
    expect(prisma.lead.count).not.toHaveBeenCalled();
  });
});

describe('DashboardService.getStats — funil com kanban individual', () => {
  /** Mesma coluna clonada para tres donos: o funil do gestor tem que ver UMA. */
  const COLUNAS_CLONADAS: StageStub[] = [
    coluna({ id: 's-novo-base', nome: 'Novo', ordem: 0 }),
    coluna({ id: 's-novo-ana', nome: 'novo ', ordem: 1, user_id: 'u-a' }),
    coluna({ id: 's-novo-bruno', nome: 'Novo', ordem: 2, user_id: 'u-b' }),
    coluna({ id: 's-ganho-ana', nome: 'Ganho', ordem: 3, is_won: true, user_id: 'u-a' }),
  ];

  const CONTAGENS = [
    { chave: 's-novo-base', count: 2 },
    { chave: 's-novo-ana', count: 5 },
    { chave: 's-novo-bruno', count: 3 },
    { chave: 's-ganho-ana', count: 4 },
  ];

  it('toggle ON junta as homonimas num item so, somando as contagens', async () => {
    const { service } = montarStats({
      kanbanIndividual: true,
      stages: COLUNAS_CLONADAS,
      porEstagio: CONTAGENS,
    });

    const r = await service.getStats(GERENTE);

    expect(r.leadsByStage).toEqual([
      { stageId: 's-novo-base', nome: 'Novo', cor: '#3498DB', count: 10 },
      { stageId: 's-ganho-ana', nome: 'Ganho', cor: '#3498DB', count: 4 },
    ]);
  });

  it('o item agregado herda id, nome e cor da coluna de menor ordem', async () => {
    const { service } = montarStats({
      kanbanIndividual: true,
      stages: [
        coluna({ id: 's-tarde', nome: 'PROPOSTA', ordem: 9, cor: '#111111', user_id: 'u-b' }),
        coluna({ id: 's-cedo', nome: 'Proposta', ordem: 2, cor: '#00FF00', user_id: 'u-a' }),
      ],
      porEstagio: [
        { chave: 's-tarde', count: 1 },
        { chave: 's-cedo', count: 2 },
      ],
    });

    const r = await service.getStats(GERENTE);

    expect(r.leadsByStage).toEqual([
      { stageId: 's-cedo', nome: 'Proposta', cor: '#00FF00', count: 3 },
    ]);
  });

  it('toggle OFF mantem um item por coluna, como antes', async () => {
    const { service } = montarStats({
      kanbanIndividual: false,
      stages: COLUNAS_CLONADAS,
      porEstagio: CONTAGENS,
    });

    const r = await service.getStats(GERENTE);

    expect(r.leadsByStage.map((s) => s.stageId)).toEqual([
      's-novo-base',
      's-novo-ana',
      's-novo-bruno',
      's-ganho-ana',
    ]);
  });

  it('agregar por nome nao mexe na taxa de conversao', async () => {
    const { service } = montarStats({
      kanbanIndividual: true,
      stages: COLUNAS_CLONADAS,
      porEstagio: CONTAGENS,
      total: 28,
    });

    const r = await service.getStats(GERENTE);

    // 4 ganhos em 28 leads = 14%, com ou sem agregacao.
    expect(r.conversionRate).toBe(14);
  });

  /**
   * O clone nasce com o nome da base — DENTRO do pipeline. Dois pipelines do
   * mesmo tenant costumam ter "Novo" cada um, e sao processos diferentes:
   * agregar so pelo nome somaria os dois numa linha unica, com um id de coluna
   * que nem pertence ao outro funil.
   */
  it('homonimas de PIPELINES diferentes continuam sendo linhas separadas', async () => {
    const { service } = montarStats({
      kanbanIndividual: true,
      stages: [
        coluna({ id: 's-a-novo', nome: 'Novo', ordem: 0, pipeline_id: 'p-a' }),
        coluna({ id: 's-a-novo-ana', nome: 'novo', ordem: 1, pipeline_id: 'p-a', user_id: 'u-a' }),
        coluna({ id: 's-b-novo', nome: 'Novo', ordem: 2, pipeline_id: 'p-b' }),
      ],
      porEstagio: [
        { chave: 's-a-novo', count: 2 },
        { chave: 's-a-novo-ana', count: 3 },
        { chave: 's-b-novo', count: 7 },
      ],
    });

    const r = await service.getStats(GERENTE);

    expect(r.leadsByStage).toEqual([
      { stageId: 's-a-novo', nome: 'Novo', cor: '#3498DB', count: 5 },
      { stageId: 's-b-novo', nome: 'Novo', cor: '#3498DB', count: 7 },
    ]);
  });

  it('para o operador a agregacao e no-op: um dono, uma coluna por nome', async () => {
    const { service } = montarStats({
      kanbanIndividual: true,
      stages: [coluna({ id: 's-novo-eu', nome: 'Novo', ordem: 0, user_id: EU })],
      porEstagio: [{ chave: 's-novo-eu', count: 6 }],
    });

    const r = await service.getStats(OPERADOR);

    expect(r.leadsByStage).toEqual([
      { stageId: 's-novo-eu', nome: 'Novo', cor: '#3498DB', count: 6 },
    ]);
  });
});
