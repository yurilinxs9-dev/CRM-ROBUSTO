import { ZodError } from 'zod';
import { PipelinesService } from './pipelines.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * `probabilidade` da etapa alimenta a previsao ponderada do dashboard. O campo
 * vem cru do painel de configuracao, entao o Zod e a unica coisa entre o gestor
 * e um "chance de fechar: 900%" gravado no banco. `null` e valor legitimo: e
 * como se volta ao default por posicao.
 */

const TENANT = 'tenant-1';

const gerente: AuthUser = {
  id: 'g1',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as never,
  ativo: true,
  tenantId: TENANT,
};

function montar(
  opts: { kanbanOn?: boolean; stage?: Record<string, unknown>; membros?: { id: string }[] } = {},
) {
  const prisma = {
    stage: {
      findFirst: jest.fn().mockResolvedValue({
        id: 's-1',
        tenant_id: TENANT,
        pipeline_id: 'p-1',
        ordem: 0,
        user_id: null,
        ...(opts.stage ?? {}),
      }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 's-nova', ...data }),
      ),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 's-1', ...data }),
      ),
      delete: jest.fn().mockResolvedValue({ id: 's-1' }),
    },
    lead: {
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      // Usado só pelo deleteWithMoveLeads com o kanban individual ligado, para
      // agrupar os leads que atravessam de pipeline por dono.
      findMany: jest.fn().mockResolvedValue([]),
    },
    user: { findMany: jest.fn().mockResolvedValue(opts.membros ?? []) },
    pipeline: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({ id: 'p-1', tenant_id: TENANT, stages: [] }),
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 'p-novo', ...data, stages: [] }),
      ),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn().mockResolvedValue({ id: 'p-1' }),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((arg: unknown) =>
    typeof arg === 'function'
      ? (arg as (tx: unknown) => unknown)(prisma)
      : Promise.all(arg as Promise<unknown>[]),
  );
  const cache = { delPattern: jest.fn().mockResolvedValue(undefined) };
  const messages = {};
  const kanban = {
    isOn: jest.fn().mockResolvedValue(opts.kanbanOn ?? false),
    cloneBaseForUser: jest.fn().mockResolvedValue(undefined),
    // Toggle desligado = traducao identidade, como o service real.
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
  };
  return {
    service: new PipelinesService(
      prisma as never,
      cache as never,
      messages as never,
      kanban as never,
    ),
    prisma,
    kanban,
  };
}

/** where das etapas montado pelo findAll na ultima chamada. */
function whereDasEtapasNoFindMany(prisma: {
  pipeline: { findMany: jest.Mock };
}): unknown {
  const arg = prisma.pipeline.findMany.mock.calls.at(-1)?.[0] as {
    include: { stages: { where?: unknown } };
  };
  return arg.include.stages.where;
}

/** where das etapas montado pelo findOne na ultima chamada. */
function whereDasEtapasNoFindFirst(prisma: {
  pipeline: { findFirst: jest.Mock };
}): unknown {
  const arg = prisma.pipeline.findFirst.mock.calls.at(-1)?.[0] as {
    include: { stages: { where?: unknown } };
  };
  return arg.include.stages.where;
}

describe('PipelinesService.updateStage — probabilidade', () => {
  it('grava a probabilidade informada', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { probabilidade: 70 }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data.probabilidade).toBe(70);
  });

  it('aceita null para voltar ao default por posicao', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { probabilidade: null }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data.probabilidade).toBeNull();
  });

  it('aceita os extremos 0 e 100', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { probabilidade: 0 }, gerente);
    await service.updateStage('s-1', { probabilidade: 100 }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data.probabilidade).toBe(0);
    expect(prisma.stage.update.mock.calls[1][0].data.probabilidade).toBe(100);
  });

  /** ZodError vira 400 no AllExceptionFilter global. */
  it('recusa 101 e nao chega no banco', async () => {
    const { service, prisma } = montar();

    await expect(service.updateStage('s-1', { probabilidade: 101 }, gerente)).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(prisma.stage.update).not.toHaveBeenCalled();
  });

  it('recusa negativo e fracionario', async () => {
    const { service } = montar();

    await expect(service.updateStage('s-1', { probabilidade: -1 }, gerente)).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(
      service.updateStage('s-1', { probabilidade: 33.3 }, gerente),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('corpo sem probabilidade nao toca no campo', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { nome: 'Proposta' }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data).toEqual({ nome: 'Proposta' });
  });
});

/**
 * A rota PATCH /stages/:id e liberada para OPERADOR (renomear/cor no dia a
 * dia), mas o mesmo endpoint carrega campos estruturais. A guarda fina do
 * service e o que impede um operador de mexer em automacao/SLA/probabilidade.
 */
describe('PipelinesService.updateStage — guarda fina por papel', () => {
  const operador: AuthUser = { ...gerente, id: 'o1', nome: 'Isamara', role: UserRole.OPERADOR as never };

  it('operador renomeia e troca cor', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { nome: 'Orcamento', cor: '#AA00FF' }, operador);

    expect(prisma.stage.update.mock.calls[0][0].data).toEqual({ nome: 'Orcamento', cor: '#AA00FF' });
  });

  it.each([
    { probabilidade: 50 },
    { is_won: true },
    { sla_config: { duration: 1 } },
    { cadence_config: [] },
    { nome: 'ok', max_dias: 3 },
  ])('operador com campo estrutural %j leva 403 e nada e gravado', async (payload) => {
    const { service, prisma } = montar();

    await expect(service.updateStage('s-1', payload, operador)).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.stage.update).not.toHaveBeenCalled();
  });

  it('gerente segue alterando campos estruturais', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { is_won: true, probabilidade: 90 }, gerente);

    expect(prisma.stage.update).toHaveBeenCalled();
  });

  it('super admin passa como gestor', async () => {
    const { service, prisma } = montar();
    const admin: AuthUser = { ...gerente, role: UserRole.SUPER_ADMIN as never };

    await service.updateStage('s-1', { probabilidade: 10 }, admin);

    expect(prisma.stage.update).toHaveBeenCalled();
  });
});

/**
 * Kanban individual: com o toggle ligado cada membro le a copia dele das
 * colunas (Stage.user_id = membro). O board base (user_id null) continua sendo
 * o modelo do tenant e so gestor alcanca ele — ou o board de outra pessoa, via
 * "Ver como". Com o toggle desligado nada muda: todo mundo le a base.
 */
describe('PipelinesService — escopo de leitura das etapas', () => {
  const operador: AuthUser = {
    ...gerente,
    id: 'o1',
    nome: 'Isamara',
    role: UserRole.OPERADOR as never,
  };
  const visualizador: AuthUser = {
    ...gerente,
    id: 'v1',
    nome: 'Auditor',
    role: UserRole.VISUALIZADOR as never,
  };

  it('toggle OFF: le so as colunas base, sem filtro por membro', async () => {
    const { service, prisma } = montar({ kanbanOn: false });

    await service.findAll(operador);

    expect(whereDasEtapasNoFindMany(prisma)).toEqual({ user_id: null });
  });

  it('toggle ON: cada um le as proprias colunas', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findAll(operador);

    expect(whereDasEtapasNoFindMany(prisma)).toEqual({ user_id: 'o1' });
  });

  it('toggle ON + view_as por gerente: le as colunas do membro observado', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findAll(gerente, false, { viewAsUserId: 'o1' });

    expect(whereDasEtapasNoFindMany(prisma)).toEqual({ user_id: 'o1' });
  });

  it('toggle ON + view_as por operador: 403 e nada e consultado', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await expect(
      service.findAll(operador, false, { viewAsUserId: 'outro' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.pipeline.findMany).not.toHaveBeenCalled();
  });

  it("toggle ON + stage_scope 'base' por gerente: le o modelo do tenant", async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findAll(gerente, false, { stageScope: 'base' });

    expect(whereDasEtapasNoFindMany(prisma)).toEqual({ user_id: null });
  });

  it("toggle ON + stage_scope 'base' por operador: 403 e nada e consultado", async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await expect(
      service.findAll(operador, false, { stageScope: 'base' }),
    ).rejects.toMatchObject({ status: 403 });
    expect(prisma.pipeline.findMany).not.toHaveBeenCalled();
  });

  it('view_as apontando para si mesmo nao exige gestor', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findAll(operador, false, { viewAsUserId: 'o1' });

    expect(whereDasEtapasNoFindMany(prisma)).toEqual({ user_id: 'o1' });
  });

  it('findOne aplica o mesmo escopo', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findOne('p-1', gerente, { viewAsUserId: 'o1' });

    expect(whereDasEtapasNoFindFirst(prisma)).toEqual({ user_id: 'o1' });
  });

  /**
   * GATE: o enable() so clona a base para PAPEIS_COM_BOARD — VISUALIZADOR fica
   * sem coluna nenhuma. Lendo `{ user_id: 'v1' }` ele veria um board VAZIO para
   * sempre, sem nenhum erro que denunciasse o motivo.
   */
  it('toggle ON + VISUALIZADOR: le a BASE, porque nunca ganhou colunas proprias', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findAll(visualizador);

    expect(whereDasEtapasNoFindMany(prisma)).toEqual({ user_id: null });
  });

  it('toggle ON + VISUALIZADOR no findOne: mesma regra', async () => {
    const { service, prisma } = montar({ kanbanOn: true });

    await service.findOne('p-1', visualizador);

    expect(whereDasEtapasNoFindFirst(prisma)).toEqual({ user_id: null });
  });

  it('findOne com toggle OFF continua na base', async () => {
    const { service, prisma } = montar({ kanbanOn: false });

    await service.findOne('p-1', operador);

    expect(whereDasEtapasNoFindFirst(prisma)).toEqual({ user_id: null });
  });
});

/**
 * Escrita das etapas com o kanban individual ligado: cada um mexe no proprio
 * board; o modelo base (user_id null) e so de gestor; e ninguem — nem gestor —
 * edita a coluna de outro membro, senao o board pessoal deixa de ser pessoal.
 * Com o toggle desligado nada disso existe: as etapas continuam todas na base.
 */
describe('PipelinesService — escrita de etapas escopada por dono', () => {
  const operador: AuthUser = {
    ...gerente,
    id: 'o1',
    nome: 'Isamara',
    role: UserRole.OPERADOR as never,
  };
  const ID_A = '11111111-1111-4111-8111-111111111111';
  const ID_B = '22222222-2222-4222-8222-222222222222';

  describe('createStage', () => {
    it('toggle ON: operador cria a coluna no proprio board', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { ordem: 2, user_id: 'o1' } });

      await service.createStage('p-1', { nome: 'Orcamento' }, operador);

      expect(prisma.stage.create.mock.calls[0][0].data).toMatchObject({
        nome: 'Orcamento',
        user_id: 'o1',
        ordem: 3,
      });
    });

    it('toggle ON: a ordem e calculada dentro do escopo do dono', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { ordem: 2, user_id: 'o1' } });

      await service.createStage('p-1', { nome: 'Orcamento' }, operador);

      expect(prisma.stage.findFirst.mock.calls[0][0].where).toMatchObject({ user_id: 'o1' });
    });

    it("toggle ON: operador pedindo scope 'base' leva 403 e nada e criado", async () => {
      const { service, prisma } = montar({ kanbanOn: true });

      await expect(
        service.createStage('p-1', { nome: 'Orcamento', scope: 'base' }, operador),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.create).not.toHaveBeenCalled();
    });

    it("toggle ON: gestor com scope 'base' cria no modelo do tenant", async () => {
      const { service, prisma } = montar({ kanbanOn: true });

      await service.createStage('p-1', { nome: 'Orcamento', scope: 'base' }, gerente);

      expect(prisma.stage.create.mock.calls[0][0].data.user_id).toBeNull();
    });

    it('toggle OFF: continua criando na base mesmo para operador', async () => {
      const { service, prisma } = montar({ kanbanOn: false });

      await service.createStage('p-1', { nome: 'Orcamento' }, operador);

      expect(prisma.stage.create.mock.calls[0][0].data.user_id).toBeNull();
    });
  });

  describe('updateStage', () => {
    it('toggle ON: operador edita a propria coluna', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: 'o1' } });

      await service.updateStage('s-1', { nome: 'Orcamento' }, operador);

      expect(prisma.stage.update).toHaveBeenCalled();
    });

    it('toggle ON: operador editando coluna de colega leva 403', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: 'o2' } });

      await expect(
        service.updateStage('s-1', { nome: 'Orcamento' }, operador),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.update).not.toHaveBeenCalled();
    });

    it('toggle ON: operador editando a base leva 403', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: null } });

      await expect(
        service.updateStage('s-1', { nome: 'Orcamento' }, operador),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.update).not.toHaveBeenCalled();
    });

    it('toggle ON: gestor edita a base', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: null } });

      await service.updateStage('s-1', { probabilidade: 60 }, gerente);

      expect(prisma.stage.update).toHaveBeenCalled();
    });

    it('toggle ON: gestor editando coluna de membro leva 403', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: 'o1' } });

      await expect(
        service.updateStage('s-1', { probabilidade: 60 }, gerente),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.update).not.toHaveBeenCalled();
    });
  });

  describe('removeStage', () => {
    it('toggle ON: operador remove a propria coluna', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: 'o1' } });

      await service.removeStage('s-1', operador);

      expect(prisma.stage.delete).toHaveBeenCalled();
    });

    it('toggle ON: operador removendo a base leva 403', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: null } });

      await expect(service.removeStage('s-1', operador)).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.delete).not.toHaveBeenCalled();
    });

    it('toggle ON: gestor removendo coluna de membro leva 403', async () => {
      const { service, prisma } = montar({ kanbanOn: true, stage: { user_id: 'o1' } });

      await expect(service.removeStage('s-1', gerente)).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.delete).not.toHaveBeenCalled();
    });
  });

  describe('removeStageWithMove', () => {
    it('toggle ON: destino de outro escopo leva 400 e nada e movido', async () => {
      const { service, prisma } = montar({ kanbanOn: true });
      prisma.stage.findFirst
        .mockResolvedValueOnce({ id: ID_A, tenant_id: TENANT, pipeline_id: 'p-1', user_id: 'o1' })
        .mockResolvedValueOnce({ id: ID_B, user_id: null });

      await expect(
        service.removeStageWithMove(ID_A, { targetStageId: ID_B }, operador),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.lead.updateMany).not.toHaveBeenCalled();
      expect(prisma.stage.delete).not.toHaveBeenCalled();
    });

    it('toggle ON: destino do mesmo dono move os leads e apaga a etapa', async () => {
      const { service, prisma } = montar({ kanbanOn: true });
      prisma.stage.findFirst
        .mockResolvedValueOnce({ id: ID_A, tenant_id: TENANT, pipeline_id: 'p-1', user_id: 'o1' })
        .mockResolvedValueOnce({ id: ID_B, user_id: 'o1' });

      const r = await service.removeStageWithMove(ID_A, { targetStageId: ID_B }, operador);

      expect(r).toEqual({ success: true, movedTo: ID_B });
      expect(prisma.stage.delete).toHaveBeenCalled();
    });
  });

  describe('reorderStages', () => {
    it('toggle ON: id de outro escopo na lista leva 400', async () => {
      const { service, prisma } = montar({ kanbanOn: true });
      prisma.stage.findMany.mockResolvedValueOnce([
        { id: ID_A, user_id: 'o1' },
        { id: ID_B, user_id: null },
      ]);

      await expect(
        service.reorderStages('p-1', { stageIds: [ID_A, ID_B] }, operador),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.stage.update).not.toHaveBeenCalled();
    });

    it('toggle ON: board de outro membro leva 403', async () => {
      const { service, prisma } = montar({ kanbanOn: true });
      prisma.stage.findMany.mockResolvedValueOnce([
        { id: ID_A, user_id: 'o2' },
        { id: ID_B, user_id: 'o2' },
      ]);

      await expect(
        service.reorderStages('p-1', { stageIds: [ID_A, ID_B] }, operador),
      ).rejects.toMatchObject({ status: 403 });
      expect(prisma.stage.update).not.toHaveBeenCalled();
    });

    it('toggle ON: o proprio board reordena e a validacao fica no escopo', async () => {
      const { service, prisma } = montar({ kanbanOn: true });
      prisma.stage.findMany
        .mockResolvedValueOnce([
          { id: ID_A, user_id: 'o1' },
          { id: ID_B, user_id: 'o1' },
        ])
        .mockResolvedValueOnce([{ id: ID_A }, { id: ID_B }]);

      const r = await service.reorderStages('p-1', { stageIds: [ID_B, ID_A] }, operador);

      expect(r).toEqual({ success: true });
      expect(prisma.stage.findMany.mock.calls[1][0].where).toMatchObject({ user_id: 'o1' });
    });

    it('toggle OFF: valida contra o pipeline inteiro, sem filtro de dono', async () => {
      const { service, prisma } = montar({ kanbanOn: false });
      prisma.stage.findMany.mockResolvedValueOnce([{ id: ID_A }, { id: ID_B }]);

      await service.reorderStages('p-1', { stageIds: [ID_B, ID_A] }, operador);

      expect(prisma.stage.findMany).toHaveBeenCalledTimes(1);
      expect(prisma.stage.findMany.mock.calls[0][0].where.user_id).toBeUndefined();
    });
  });

  describe('pipeline novo e duplicado', () => {
    it('toggle ON: clona a base para cada membro ativo na mesma transacao', async () => {
      const { service, prisma, kanban } = montar({
        kanbanOn: true,
        membros: [{ id: 'o1' }, { id: 'o2' }],
      });

      await service.create({ nome: 'Funil novo' }, gerente);

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(kanban.cloneBaseForUser).toHaveBeenCalledTimes(2);
      expect(kanban.cloneBaseForUser.mock.calls[0].slice(1)).toEqual([TENANT, 'o1', 'p-novo']);
      expect(kanban.cloneBaseForUser.mock.calls[1].slice(1)).toEqual([TENANT, 'o2', 'p-novo']);
    });

    it('toggle OFF: pipeline novo nasce so com a base', async () => {
      const { service, kanban } = montar({ kanbanOn: false, membros: [{ id: 'o1' }] });

      await service.create({ nome: 'Funil novo' }, gerente);

      expect(kanban.cloneBaseForUser).not.toHaveBeenCalled();
    });

    it('toggle ON: duplicado copia so as colunas base e clona para os membros', async () => {
      const { service, prisma, kanban } = montar({ kanbanOn: true, membros: [{ id: 'o1' }] });
      prisma.pipeline.findFirst.mockResolvedValueOnce({
        id: 'p-1',
        nome: 'Funil',
        descricao: null,
        cor: '#3b82f6',
        icone: null,
        tenant_id: TENANT,
        stages: [{ nome: 'Novo', cor: '#3498DB', ordem: 0, user_id: null }],
      });
      prisma.pipeline.findFirst.mockResolvedValueOnce(null); // nome livre

      await service.duplicate('p-1', gerente);

      expect(prisma.pipeline.findFirst.mock.calls[0][0].include.stages.where).toEqual({
        user_id: null,
      });
      expect(kanban.cloneBaseForUser).toHaveBeenCalledTimes(1);
      expect(kanban.cloneBaseForUser.mock.calls[0].slice(1)).toEqual([TENANT, 'o1', 'p-novo']);
    });
  });

  /**
   * Excluir pipeline movendo os leads: eles atravessam para o funil de destino
   * com donos DIVERSOS. A primeira etapa do destino tem que sair do MODELO BASE
   * (senao o funil inteiro cai dentro do board de um membro sorteado pelo
   * desempate da `ordem`), e dali cada grupo vai para a coluna do seu dono.
   */
  describe('deleteWithMoveLeads', () => {
    const ALVO = '33333333-3333-4333-8333-333333333333';

    function comDestino(prisma: ReturnType<typeof montar>['prisma']) {
      prisma.pipeline.findFirst
        .mockResolvedValueOnce({ id: 'p-1', tenant_id: TENANT }) // origem
        .mockResolvedValueOnce({
          id: ALVO,
          tenant_id: TENANT,
          stages: [{ id: 'base-primeira' }],
        });
    }

    it('le a primeira etapa do destino no modelo base (user_id null)', async () => {
      const { service, prisma } = montar({ kanbanOn: true });
      comDestino(prisma);

      await service.deleteWithMoveLeads('p-1', { targetPipelineId: ALVO }, gerente);

      expect(prisma.pipeline.findFirst.mock.calls[1][0].include.stages.where).toEqual({
        user_id: null,
      });
    });

    it('toggle ON: cada dono leva os leads dele para a coluna equivalente', async () => {
      const { service, prisma, kanban } = montar({ kanbanOn: true });
      comDestino(prisma);
      prisma.lead.findMany.mockResolvedValue([
        { id: 'l1', responsavel_id: 'u-alex' },
        { id: 'l2', responsavel_id: 'u-alex' },
        { id: 'l3', responsavel_id: 'u-bia' },
        { id: 'l4', responsavel_id: null },
      ]);
      kanban.stageForOwner.mockImplementation(async (_t: string, dono: string) => `col-${dono}`);
      kanban.stageForBase.mockResolvedValue('col-base');

      await service.deleteWithMoveLeads('p-1', { targetPipelineId: ALVO }, gerente);

      expect(kanban.stageForOwner).toHaveBeenCalledTimes(2);
      expect(kanban.stageForBase).toHaveBeenCalledWith(TENANT, 'base-primeira');
      const grupos = prisma.lead.updateMany.mock.calls
        .slice(0, 3)
        .map(([arg]: [{ where: { id: { in: string[] } }; data: { estagio_id: string } }]) => ({
          ids: arg.where.id.in,
          estagio_id: arg.data.estagio_id,
        }));
      expect(grupos).toEqual([
        { ids: ['l1', 'l2'], estagio_id: 'col-u-alex' },
        { ids: ['l3'], estagio_id: 'col-u-bia' },
        { ids: ['l4'], estagio_id: 'col-base' },
      ]);
      // Rede final: sobra do pipeline vai para a base do destino.
      expect(prisma.lead.updateMany.mock.calls.at(-1)?.[0]).toEqual({
        where: { pipeline_id: 'p-1', tenant_id: TENANT },
        data: { pipeline_id: ALVO, estagio_id: 'base-primeira' },
      });
    });

    it('toggle OFF: um unico updateMany, exatamente como antes da feature', async () => {
      const { service, prisma, kanban } = montar({ kanbanOn: false });
      comDestino(prisma);

      await service.deleteWithMoveLeads('p-1', { targetPipelineId: ALVO }, gerente);

      expect(prisma.lead.findMany).not.toHaveBeenCalled();
      expect(kanban.stageForOwner).not.toHaveBeenCalled();
      expect(prisma.lead.updateMany).toHaveBeenCalledTimes(1);
      expect(prisma.lead.updateMany.mock.calls[0][0]).toEqual({
        where: { pipeline_id: 'p-1', tenant_id: TENANT },
        data: { pipeline_id: ALVO, estagio_id: 'base-primeira' },
      });
    });
  });
});
