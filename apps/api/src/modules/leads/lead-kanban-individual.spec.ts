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
      findFirst: jest.fn().mockResolvedValue({
        id: 'lead-1',
        responsavel_id: null,
        instancia_whatsapp: null,
        estagio_id: 'base-novo',
      }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    stage: { findMany: jest.fn().mockResolvedValue([]) },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }),
      findUnique: jest.fn().mockResolvedValue({ pool_enabled: false }),
    },
    conversation: { findMany: jest.fn(), update: jest.fn() },
    user: {
      findFirst: jest.fn(),
      findUnique: jest.fn().mockResolvedValue({ focus_mode: false }),
    },
    sector: { findFirst: jest.fn() },
    leadActivity: { create: jest.fn() },
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
  const gateway: any = { emitLeadUpdated: jest.fn() };
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
    {} as any, // autoActionsQueue (BullMQ)
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

    // Primeira coluna (menor ordem): a dela OU qualquer devolvido sem dono —
    // o lead devolvido vive numa coluna BASE, que nao esta no conjunto do
    // viewer, e sem isto ficaria invisivel no board dele.
    expect(whereDaColuna(prisma, 0).AND).toContainEqual({
      OR: [{ estagio_id: 's-a' }, { responsavel_id: null, returned_at: { not: null } }],
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
