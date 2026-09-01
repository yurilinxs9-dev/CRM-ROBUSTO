import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task 6 (kanban individual): a etapa do lead ACOMPANHA o dono.
 *
 * Com o toggle ligado cada membro tem uma copia das colunas base
 * (`Stage.user_id = membro`). Um lead que troca de dono precisa trocar de
 * COLUNA junto — senao ele fica parado na coluna de um board que o novo
 * responsavel nao enxerga, e some da tela de todo mundo.
 *
 * Invariante desta suite:
 *
 *   lead.responsavel_id = X  =>  lead.estagio_id pertence ao board de X
 *   lead sem dono            =>  lead.estagio_id pertence a BASE do tenant
 *
 * Com o toggle DESLIGADO nada disso existe: `stageForOwner`/`stageForBase`
 * devolvem o proprio id recebido, e cada caso abaixo tem o par "toggle OFF" que
 * trava o no-op — regressao aqui seria mexer em `estagio_id` de tenant que nem
 * ligou a feature.
 *
 * Estilo dos mocks copiado de `lead-returned-at.spec.ts`, que exercita as
 * mesmas rotas de troca de dono: `txClient` e um objeto SEPARADO do `prisma`
 * porque claim/reassign/returnToPool escrevem o lead dentro do `$transaction`.
 */

function makeMocks() {
  const txClient: any = {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-1', nome: 'Cliente', ...data }),
      ),
    },
    conversation: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn(),
    },
    leadActivity: { create: jest.fn() },
  };
  const prisma: any = {
    lead: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-1', nome: 'Cliente', ...data }),
      ),
      aggregate: jest.fn().mockResolvedValue({ _min: { position: null } }),
      findFirst: jest.fn().mockResolvedValue({
        id: 'lead-1',
        responsavel_id: null,
        instancia_whatsapp: null,
        estagio_id: 'base-novo',
        mensagens_nao_lidas: 0,
      }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    stage: {
      findMany: jest.fn().mockResolvedValue([]),
      // `updateStage` le a etapa duas vezes (nome para a atividade, is_won/
      // is_lost para o webhook). Um retorno so serve para as duas.
      findUnique: jest.fn().mockResolvedValue({ nome: 'Negociando', is_won: false, is_lost: false }),
    },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }),
      findUnique: jest.fn().mockResolvedValue({ pool_enabled: false }),
    },
    conversation: { findMany: jest.fn(), update: jest.fn() },
    user: {
      findFirst: jest.fn(),
      // Auditoria da reatribuicao em massa (Task D2) le os nomes envolvidos.
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue({ focus_mode: false }),
    },
    sector: { findFirst: jest.fn() },
    leadActivity: { create: jest.fn(), createMany: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => unknown)(txClient);
    }),
  };
  const cache: any = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delPattern: jest.fn(),
  };
  const gateway: any = {
    emitLeadUpdated: jest.fn(),
    emitLeadStageChanged: jest.fn(),
    emitLeadUnreadReset: jest.fn(),
  };
  const autoActionsQueue: any = { add: jest.fn().mockResolvedValue(undefined) };
  const push: any = { sendToUsers: jest.fn() };
  const assignment: any = { assignBySector: jest.fn() };
  const outboundWebhooks: any = {
    dispatchLeadEvent: jest.fn().mockResolvedValue(undefined),
  };
  // Default = toggle DESLIGADO: as duas traducoes sao identidade, exatamente
  // como o service real se comporta com `kanban_individual = false`.
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(false),
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
  };
  return {
    prisma,
    txClient,
    cache,
    gateway,
    push,
    assignment,
    outboundWebhooks,
    kanbanIndividual,
    autoActionsQueue,
  };
}

function makeService() {
  const m = makeMocks();
  const service = new LeadsService(
    m.prisma,
    {} as any, // InstancesService
    m.cache,
    m.gateway,
    {} as any, // MediaService
    m.push,
    m.outboundWebhooks,
    m.assignment,
    {} as any, // CustomFieldsService
    m.autoActionsQueue,
    m.kanbanIndividual,
  );
  return { service, ...m };
}

const alex: AuthUser = {
  id: 'u-alex',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};
const gerente: AuthUser = {
  ...alex,
  id: 'u-gerente',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
};
const visualizador: AuthUser = {
  ...alex,
  id: 'u-visualizador',
  role: UserRole.VISUALIZADOR as unknown as AuthUser['role'],
};

/** `data` da chamada de indice `i` no mock. */
const dataDaChamada = (mock: jest.Mock, i = 0) => mock.mock.calls[i][0].data;
/** Payload do unico `emitLeadUpdated`. */
const payloadEmitido = (gateway: { emitLeadUpdated: jest.Mock }) =>
  gateway.emitLeadUpdated.mock.calls[0][1];

describe('claim — a coluna acompanha quem assumiu', () => {
  it('toggle ON: remapeia estagio_id para a coluna do claimer e carimba a entrada', async () => {
    const { service, txClient, kanbanIndividual, gateway } = makeService();
    kanbanIndividual.stageForOwner.mockResolvedValue('alex-novo');

    const r = await service.claim('lead-1', alex);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith('t1', 'u-alex', 'base-novo');
    expect(txClient.lead.update).toHaveBeenCalledTimes(1);
    expect(dataDaChamada(txClient.lead.update)).toEqual({
      estagio_id: 'alex-novo',
      estagio_entered_at: expect.any(Date),
    });
    // Regra global do projeto: mutacao de Kanban SEMPRE emite — e o payload tem
    // que carregar a coluna nova, senao o card fica na coluna velha do board.
    expect(payloadEmitido(gateway)).toEqual({
      responsavel_id: 'u-alex',
      estagio_id: 'alex-novo',
    });
    expect(r.estagio_id).toBe('alex-novo');
  });

  it('toggle OFF: nao toca em estagio_id (nenhum update extra, payload antigo)', async () => {
    const { service, txClient, gateway } = makeService();

    await service.claim('lead-1', alex);

    expect(txClient.lead.update).not.toHaveBeenCalled();
    expect(payloadEmitido(gateway)).toEqual({ responsavel_id: 'u-alex' });
  });
});

describe('reassign — a coluna acompanha o novo responsavel', () => {
  const novoResponsavelId = '11111111-1111-1111-1111-111111111111';

  function comLeadDeOutro(prisma: any) {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-gerente',
      instancia_whatsapp: 'inst-x',
      estagio_id: 'gerente-novo',
    });
    prisma.user.findFirst.mockResolvedValue({ id: novoResponsavelId, role: 'OPERADOR' });
  }

  it('toggle ON: o update do lead ja leva a coluna do destino', async () => {
    const { service, txClient, prisma, kanbanIndividual, gateway } = makeService();
    comLeadDeOutro(prisma);
    kanbanIndividual.stageForOwner.mockResolvedValue('destino-novo');

    await service.reassign('lead-1', { novoResponsavelId }, gerente);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith(
      't1',
      novoResponsavelId,
      'gerente-novo',
    );
    expect(dataDaChamada(txClient.lead.update)).toEqual({
      responsavel_id: novoResponsavelId,
      assumed_at: expect.any(Date),
      returned_at: null,
      is_private: false,
      estagio_id: 'destino-novo',
      estagio_entered_at: expect.any(Date),
    });
    expect(payloadEmitido(gateway)).toEqual({
      responsavel_id: novoResponsavelId,
      estagio_id: 'destino-novo',
    });
  });

  it('toggle OFF: o data do update fica exatamente o de antes da feature', async () => {
    const { service, txClient, prisma, gateway } = makeService();
    comLeadDeOutro(prisma);

    await service.reassign('lead-1', { novoResponsavelId }, gerente);

    expect(dataDaChamada(txClient.lead.update)).toEqual({
      responsavel_id: novoResponsavelId,
      assumed_at: expect.any(Date),
      returned_at: null,
      is_private: false,
    });
    expect(payloadEmitido(gateway)).toEqual({ responsavel_id: novoResponsavelId });
  });
});

describe('returnToPool — lead sem dono volta para a BASE', () => {
  function comLeadDoAlex(prisma: any) {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-alex',
      instancia_whatsapp: 'inst-alex',
      estagio_id: 'alex-negociando',
    });
  }

  it('toggle ON: mesma escrita que carimba returned_at leva a coluna base', async () => {
    const { service, txClient, prisma, kanbanIndividual, gateway } = makeService();
    comLeadDoAlex(prisma);
    kanbanIndividual.stageForBase.mockResolvedValue('base-negociando');

    await service.returnToPool('lead-1', alex);

    expect(kanbanIndividual.stageForBase).toHaveBeenCalledWith('t1', 'alex-negociando');
    expect(txClient.lead.update).toHaveBeenCalledTimes(1);
    expect(dataDaChamada(txClient.lead.update)).toEqual({
      responsavel_id: null,
      assumed_at: null,
      is_private: false,
      returned_at: expect.any(Date),
      estagio_id: 'base-negociando',
      estagio_entered_at: expect.any(Date),
    });
    expect(payloadEmitido(gateway)).toEqual({
      responsavel_id: null,
      estagio_id: 'base-negociando',
    });
  });

  it('toggle OFF: devolucao continua sem mexer na coluna', async () => {
    const { service, txClient, prisma, gateway } = makeService();
    comLeadDoAlex(prisma);

    await service.returnToPool('lead-1', alex);

    expect(dataDaChamada(txClient.lead.update)).toEqual({
      responsavel_id: null,
      assumed_at: null,
      is_private: false,
      returned_at: expect.any(Date),
    });
    expect(payloadEmitido(gateway)).toEqual({ responsavel_id: null });
  });
});

/**
 * `updateStage` (arrastar um card no board, mudar a etapa pelo chat): a coluna
 * PEDIDA e a do board de quem move, que nem sempre e o board do dono do lead —
 * a tela de chat, por exemplo, le os pipelines sem escopo. Gravar o id cru
 * cravaria uma coluna pessoal do GESTOR num lead de colega, e o card sumiria do
 * board do dono (nenhuma coluna dele bate com aquele id).
 *
 * A acao em MASSA nao passa por aqui: e o `bulkMoveStage`, com traducao propria
 * (uma por dono) e suite propria no fim deste arquivo.
 */
describe('updateStage — a coluna pedida e traduzida para o board do dono', () => {
  const COL_GERENTE = '22222222-2222-2222-2222-222222222222';
  const COL_ALEX = '33333333-3333-3333-3333-333333333333';
  const COL_BASE = '44444444-4444-4444-4444-444444444444';

  function comLeadDoAlex(prisma: any) {
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: 'u-alex',
      instancia_whatsapp: 'inst-alex',
      estagio_id: 'alex-novo',
      mensagens_nao_lidas: 0,
    });
  }

  it('toggle ON: gestor movendo lead de colega grava a coluna DO COLEGA', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comLeadDoAlex(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForOwner.mockResolvedValue(COL_ALEX);

    await service.updateStage('lead-1', { estagio_id: COL_GERENTE }, gerente);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith('t1', 'u-alex', COL_GERENTE);
    expect(dataDaChamada(prisma.lead.update).estagio_id).toBe(COL_ALEX);
  });

  it('toggle ON: lead sem dono cai na BASE, nao na coluna pessoal de quem moveu', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForBase.mockResolvedValue(COL_BASE);

    await service.updateStage('lead-1', { estagio_id: COL_GERENTE }, gerente);

    expect(kanbanIndividual.stageForBase).toHaveBeenCalledWith('t1', COL_GERENTE);
    expect(dataDaChamada(prisma.lead.update).estagio_id).toBe(COL_BASE);
  });

  it('toggle OFF: grava exatamente a coluna pedida (nenhuma traducao)', async () => {
    const { service, prisma } = makeService();
    comLeadDoAlex(prisma);

    await service.updateStage('lead-1', { estagio_id: COL_GERENTE }, gerente);

    expect(dataDaChamada(prisma.lead.update).estagio_id).toBe(COL_GERENTE);
  });

  it('a atividade e o evento WS carregam a coluna TRADUZIDA, nao a pedida', async () => {
    const { service, prisma, kanbanIndividual, gateway } = makeService();
    comLeadDoAlex(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForOwner.mockResolvedValue(COL_ALEX);

    await service.updateStage('lead-1', { estagio_id: COL_GERENTE }, gerente);

    expect(dataDaChamada(prisma.leadActivity.create).dados_depois).toEqual({
      estagio_id: COL_ALEX,
    });
    expect(gateway.emitLeadStageChanged.mock.calls[0][1]).toEqual({
      newStageId: COL_ALEX,
      oldStageId: 'alex-novo',
      leadId: 'lead-1',
      triggeredByUserId: 'u-gerente',
    });
  });
});

/**
 * Board janelado (`per_stage`): as colunas que o board consulta tem que ser as
 * do VIEWER, senao o gerente e o operador leriam o mesmo conjunto base e o
 * board pessoal apareceria vazio (nenhum lead vive na base com o toggle ON).
 */
describe('board per_stage — conjunto de colunas escopado por dono', () => {
  const STAGES = [
    { id: 's-a', ordem: 0 },
    { id: 's-b', ordem: 1 },
  ];

  function comStages(prisma: any) {
    prisma.stage.findMany.mockResolvedValue(STAGES);
  }

  const whereDoStageFindMany = (prisma: any) => prisma.stage.findMany.mock.calls[0][0].where;
  const whereDaColuna = (prisma: any, i: number) => prisma.lead.findMany.mock.calls[i][0].where;

  it('toggle OFF: le a base do tenant (user_id null), como antes da feature', async () => {
    const { service, prisma } = makeService();
    comStages(prisma);

    await service.findAll(alex, { per_stage: '50', pipeline_id: 'p-1' });

    expect(whereDoStageFindMany(prisma)).toEqual({ pipeline_id: 'p-1', user_id: null });
  });

  it('toggle ON: le as colunas de quem pediu', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(alex, { per_stage: '50', pipeline_id: 'p-1' });

    expect(whereDoStageFindMany(prisma)).toEqual({ pipeline_id: 'p-1', user_id: 'u-alex' });
  });

  it('toggle ON + gerente com recorte por responsavel: le as colunas do membro observado', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(gerente, {
      per_stage: '50',
      pipeline_id: 'p-1',
      responsavel_id: 'u-alex',
    });

    expect(whereDoStageFindMany(prisma)).toEqual({ pipeline_id: 'p-1', user_id: 'u-alex' });
  });

  it('toggle ON + operador pedindo a carteira do colega: colunas seguem sendo as dele', async () => {
    // O recorte por outro responsavel nem chega a ser aplicado no `where` dos
    // leads (lead-visibility). Se o conjunto de colunas obedecesse ao param, o
    // operador leria o board do colega — vazio, mas ainda assim board alheio.
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(alex, {
      per_stage: '50',
      pipeline_id: 'p-1',
      responsavel_id: 'u-colega',
    });

    expect(whereDoStageFindMany(prisma)).toEqual({ pipeline_id: 'p-1', user_id: 'u-alex' });
  });

  it('toggle ON: a nuvem de devolvidos entra na PRIMEIRA coluna', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(alex, { per_stage: '50', pipeline_id: 'p-1' });

    // Primeira coluna (menor ordem): a dela, OU qualquer devolvido sem dono, OU
    // qualquer lead parado numa coluna que este viewer nao conhece (a base dos
    // devolvidos; a coluna pessoal de um colega, num lead que o gestor
    // supervisiona). Sem o terceiro termo a CONTAGEM da primeira coluna somava
    // esses leads (ver o bloco de stage_counts) mas os CARDS nao apareciam em
    // lugar nenhum do board.
    expect(whereDaColuna(prisma, 0).AND).toContainEqual({
      OR: [
        { estagio_id: 's-a' },
        { responsavel_id: null, returned_at: { not: null } },
        { estagio_id: { notIn: ['s-a', 's-b'] } },
      ],
    });
    // Demais colunas: recorte simples pela coluna.
    expect(whereDaColuna(prisma, 1).AND).toContainEqual({ estagio_id: 's-b' });
    // E o OR da VISIBILIDADE (operador em modo individual: as próprias + a
    // nuvem) tem que sobreviver intacto ao lado dele. A condição da coluna
    // entra por AND justamente por isto: mesclada por spread, como era antes,
    // o OR da coluna sobrescreveria este e o board devolveria lead de colega.
    expect(whereDaColuna(prisma, 0).OR).toEqual([
      { responsavel_id: 'u-alex' },
      { responsavel_id: null, returned_at: { not: null }, is_private: false },
    ]);
  });

  /**
   * GATE do gestor supervisionando: sem recorte de responsavel ele enxerga
   * leads do time inteiro, e cada um deles vive na coluna PESSOAL do dono —
   * fora do conjunto de colunas do gestor. A contagem ja somava esses leads na
   * primeira coluna; os cards precisam cair no mesmo lugar.
   */
  it('toggle ON + gestor sem recorte: cards de coluna desconhecida entram na primeira', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(gerente, { per_stage: '50', pipeline_id: 'p-1' });

    const orDaPrimeira = (whereDaColuna(prisma, 0).AND as { OR?: unknown[] }[]).find(
      (c) => Array.isArray(c.OR),
    );
    expect(orDaPrimeira?.OR).toContainEqual({ estagio_id: { notIn: ['s-a', 's-b'] } });
  });

  /**
   * GATE do VISUALIZADOR: `enable()` so clona a base para PAPEIS_COM_BOARD, e
   * ele nao esta na lista. Pedindo `{ user_id: 'v1' }` o board viria vazio.
   */
  it('toggle ON + VISUALIZADOR: as colunas do board sao as da BASE', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(visualizador, { per_stage: '50', pipeline_id: 'p-1' });

    expect(whereDoStageFindMany(prisma)).toEqual({ pipeline_id: 'p-1', user_id: null });
  });

  /**
   * A nuvem de devolvidos so existe para quem le um conjunto PESSOAL: o lead
   * devolvido vive numa coluna base, que nao esta no board dele. Quem ja le a
   * BASE (VISUALIZADOR) recebe esse mesmo lead pela consulta da coluna dele —
   * repetir o termo na primeira coluna faria o card aparecer DUAS vezes no
   * board, em duas colunas diferentes.
   */
  it('toggle ON + VISUALIZADOR: sem o termo da nuvem, senao o devolvido duplica', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.findAll(visualizador, { per_stage: '50', pipeline_id: 'p-1' });

    expect(whereDaColuna(prisma, 0).AND).toContainEqual({
      OR: [{ estagio_id: 's-a' }, { estagio_id: { notIn: ['s-a', 's-b'] } }],
    });
  });

  it('toggle OFF: primeira coluna continua sem a nuvem', async () => {
    const { service, prisma } = makeService();
    comStages(prisma);

    await service.findAll(alex, { per_stage: '50', pipeline_id: 'p-1' });

    expect(whereDaColuna(prisma, 0).AND).toContainEqual({ estagio_id: 's-a' });
  });

  it('toggle ON: contagem de coluna fora do conjunto do viewer soma na primeira', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comStages(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);
    prisma.lead.groupBy.mockResolvedValue([
      { estagio_id: 's-a', _count: { _all: 2 }, _sum: { valor_estimado: 100 } },
      { estagio_id: 's-b', _count: { _all: 1 }, _sum: { valor_estimado: 50 } },
      // Devolvidos, parados numa coluna BASE que este viewer nao enxerga.
      { estagio_id: 'base-novo', _count: { _all: 3 }, _sum: { valor_estimado: 30 } },
    ]);

    const r = (await service.findAll(alex, {
      per_stage: '50',
      pipeline_id: 'p-1',
    })) as { stage_counts: Record<string, number>; stage_values: Record<string, number> };

    expect(r.stage_counts).toEqual({ 's-a': 5, 's-b': 1 });
    expect(r.stage_values).toEqual({ 's-a': 130, 's-b': 50 });
  });

  it('toggle OFF: contagem de coluna desconhecida NAO e realocada', async () => {
    const { service, prisma } = makeService();
    comStages(prisma);
    prisma.lead.groupBy.mockResolvedValue([
      { estagio_id: 's-a', _count: { _all: 2 }, _sum: { valor_estimado: 100 } },
      { estagio_id: 'outra', _count: { _all: 3 }, _sum: { valor_estimado: 30 } },
    ]);

    const r = (await service.findAll(alex, {
      per_stage: '50',
      pipeline_id: 'p-1',
    })) as { stage_counts: Record<string, number> };

    expect(r.stage_counts).toEqual({ 's-a': 2, outra: 3 });
  });
});

/**
 * `bulkMoveStage` (barra de acoes em massa do board): o alvo e UM id de coluna,
 * mas a selecao pode misturar donos — no board de supervisao do gestor os
 * devolvidos (sem dono) e os leads de cada membro convivem na primeira coluna.
 * Um `updateMany` unico com o id cru cravaria a coluna do gestor em todos eles.
 * A traducao e por DONO (nao por lead): selecao de 500 com 3 donos = 3 alvos.
 */
describe('bulkMoveStage — um alvo traduzido por dono da selecao', () => {
  const ALVO = '55555555-5555-5555-5555-555555555555';
  const L1 = '66666666-6666-6666-6666-666666666666';
  const L2 = '77777777-7777-7777-7777-777777777777';
  const L3 = '88888888-8888-8888-8888-888888888888';
  const L4 = '99999999-9999-9999-9999-999999999999';

  /** `{ ids, estagio_id }` de cada `updateMany`, na ordem em que sairam. */
  const gruposEscritos = (prisma: any) =>
    prisma.lead.updateMany.mock.calls.map(([arg]: any[]) => ({
      ids: arg.where.id.in,
      estagio_id: arg.data.estagio_id,
    }));

  it('toggle ON: selecao mista vira um updateMany por dono, com a coluna de cada um', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForOwner.mockImplementation(
      async (_t: string, dono: string) => `col-${dono}`,
    );
    kanbanIndividual.stageForBase.mockResolvedValue('col-base');
    prisma.lead.findMany.mockResolvedValue([
      { id: L1, responsavel_id: 'u-alex' },
      { id: L2, responsavel_id: 'u-alex' },
      { id: L3, responsavel_id: 'u-bia' },
      // Devolvido: sem dono, a coluna certa e a da BASE.
      { id: L4, responsavel_id: null },
    ]);

    const r = await service.bulkMoveStage({ ids: [L1, L2, L3, L4], estagio_id: ALVO }, gerente);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledTimes(2);
    expect(kanbanIndividual.stageForBase).toHaveBeenCalledWith('t1', ALVO);
    expect(gruposEscritos(prisma)).toEqual([
      { ids: [L1, L2], estagio_id: 'col-u-alex' },
      { ids: [L3], estagio_id: 'col-u-bia' },
      { ids: [L4], estagio_id: 'col-base' },
    ]);
    expect(r).toEqual({ updated: 3 });
  });

  it('toggle ON: o carimbo de entrada e o badge zerado continuam em todo grupo', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    kanbanIndividual.isOn.mockResolvedValue(true);
    prisma.lead.findMany.mockResolvedValue([{ id: L1, responsavel_id: 'u-alex' }]);

    await service.bulkMoveStage({ ids: [L1], estagio_id: ALVO }, gerente);

    expect(dataDaChamada(prisma.lead.updateMany)).toEqual({
      estagio_id: ALVO,
      estagio_entered_at: expect.any(Date),
      mensagens_nao_lidas: 0,
    });
  });

  it('toggle OFF: um unico updateMany, exatamente como antes da feature', async () => {
    const { service, prisma } = makeService();

    const r = await service.bulkMoveStage({ ids: [L1, L2], estagio_id: ALVO }, gerente);

    // Nem carrega os leads: sem coluna pessoal nao ha o que agrupar.
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.lead.updateMany.mock.calls[0][0].where).toEqual({
      id: { in: [L1, L2] },
      tenant_id: 't1',
    });
    expect(dataDaChamada(prisma.lead.updateMany)).toEqual({
      estagio_id: ALVO,
      estagio_entered_at: expect.any(Date),
      mensagens_nao_lidas: 0,
    });
    expect(r).toEqual({ updated: 1 });
  });

  it('toggle ON + OPERADOR: o recorte por dono da rota sobrevive a leitura da selecao', async () => {
    // O `where` do findMany e o MESMO da escrita antiga: sem o recorte, um
    // operador leria (e moveria) lead de colega passando o id na lista.
    const { service, prisma, kanbanIndividual } = makeService();
    kanbanIndividual.isOn.mockResolvedValue(true);
    prisma.lead.findMany.mockResolvedValue([{ id: L1, responsavel_id: 'u-alex' }]);

    await service.bulkMoveStage({ ids: [L1, L3], estagio_id: ALVO }, alex);

    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({
      id: { in: [L1, L3] },
      tenant_id: 't1',
      responsavel_id: 'u-alex',
    });
  });
});

/**
 * `bulkAssign` (atribuir em massa): todos vao para o MESMO dono novo, mas saem
 * de colunas diferentes — cada lead na coluna pessoal do dono anterior. Trocar
 * so o `responsavel_id` deixaria a etapa apontando para o board de quem nao tem
 * mais o lead. O board realoca card e contagem para a primeira coluna, entao
 * nada some da tela; a etapa REAL e que fica errada ate alguem mover o card.
 * Aqui a traducao e por coluna de ORIGEM distinta (o destino e um so).
 */
describe('bulkAssign — a etapa acompanha o novo dono', () => {
  const NOVO_DONO = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const L1 = '66666666-6666-6666-6666-666666666666';
  const L2 = '77777777-7777-7777-7777-777777777777';
  const L3 = '88888888-8888-8888-8888-888888888888';

  const gruposEscritos = (prisma: any) =>
    prisma.lead.updateMany.mock.calls.map(([arg]: any[]) => ({
      ids: arg.where.id.in,
      data: arg.data,
    }));

  it('toggle ON: cada coluna de origem vira a equivalente no board do novo dono', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForOwner.mockImplementation(
      async (_t: string, dono: string, from: string) => `${dono}::${from}`,
    );
    prisma.lead.findMany.mockResolvedValue([
      { id: L1, estagio_id: 'alex-negociando' },
      { id: L2, estagio_id: 'alex-negociando' },
      { id: L3, estagio_id: 'bia-novo' },
    ]);

    const r = await service.bulkAssign({ ids: [L1, L2, L3], responsavel_id: NOVO_DONO }, gerente);

    // Uma traducao por coluna de origem distinta, nao uma por lead.
    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledTimes(2);
    expect(gruposEscritos(prisma)).toEqual([
      {
        ids: [L1, L2],
        data: {
          responsavel_id: NOVO_DONO,
          returned_at: null,
          estagio_id: `${NOVO_DONO}::alex-negociando`,
          estagio_entered_at: expect.any(Date),
        },
      },
      {
        ids: [L3],
        data: {
          responsavel_id: NOVO_DONO,
          returned_at: null,
          estagio_id: `${NOVO_DONO}::bia-novo`,
          estagio_entered_at: expect.any(Date),
        },
      },
    ]);
    expect(r).toEqual({ updated: 2 });
  });

  it('toggle ON: coluna que ja e a do destino nao entra no update', async () => {
    // `remapearEtapa` devolve null quando nao ha o que mudar — sem isso o lead
    // levaria um `estagio_entered_at` novo por nada, zerando SLA e cadencia.
    const { service, prisma, kanbanIndividual } = makeService();
    kanbanIndividual.isOn.mockResolvedValue(true);
    prisma.lead.findMany.mockResolvedValue([{ id: L1, estagio_id: 'ja-do-destino' }]);

    await service.bulkAssign({ ids: [L1], responsavel_id: NOVO_DONO }, gerente);

    expect(dataDaChamada(prisma.lead.updateMany)).toEqual({
      responsavel_id: NOVO_DONO,
      returned_at: null,
    });
  });

  it('toggle OFF: um unico updateMany, exatamente como antes da feature', async () => {
    const { service, prisma } = makeService();

    const r = await service.bulkAssign({ ids: [L1, L2], responsavel_id: NOVO_DONO }, gerente);

    // O `findMany` que sobrou aqui e o da AUDITORIA (Task D2: le o dono anterior
    // de cada lead antes da troca), nao a leitura de colunas desta feature — o
    // que esta suite trava e que o toggle OFF escreve num updateMany so.
    expect(prisma.lead.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.lead.updateMany.mock.calls[0][0].where).toEqual({
      id: { in: [L1, L2] },
      tenant_id: 't1',
    });
    expect(dataDaChamada(prisma.lead.updateMany)).toEqual({
      responsavel_id: NOVO_DONO,
      returned_at: null,
    });
    expect(r).toEqual({ updated: 1 });
  });
});
