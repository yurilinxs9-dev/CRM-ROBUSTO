import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Task D2 — auditoria do Reatribuir.
 *
 * `reassign` era o UNICO caminho de troca de dono sem rastro: claim, moveToSector
 * e returnToPool gravam LeadActivity, ele nao gravava nada. Foi o que tornou a
 * distribuicao manual da Diplapel invisivel — ninguem conseguia responder "quem
 * passou este lead para quem, e quando".
 *
 * Invariante desta suite: toda troca de dono por reatribuicao (uma a uma ou em
 * massa) deixa uma LeadActivity, e a do caminho de um lead so nasce DENTRO da
 * mesma transacao do update — update que der rollback nao pode deixar atividade
 * orfa dizendo que o lead trocou de dono.
 *
 * AssignmentLog de proposito NAO entra: ele e do rodizio/fila e reatribuicao
 * manual nao mexe no ponteiro do setor.
 *
 * Estilo dos mocks copiado de `lead-kanban-individual.spec.ts` (mesmas rotas).
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
        responsavel_id: 'u-alex',
        responsavel: { nome: 'Alex' },
        instancia_whatsapp: 'inst-alex',
        estagio_id: 'base-negociando',
      }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    stage: { findMany: jest.fn().mockResolvedValue([]) },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue(null) },
    tenant: {
      findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }),
      findUnique: jest.fn().mockResolvedValue({ pool_enabled: true }),
    },
    conversation: { findMany: jest.fn(), update: jest.fn() },
    user: {
      findFirst: jest.fn().mockResolvedValue({
        id: NOVO_DONO,
        role: 'OPERADOR',
        nome: 'Bruna',
      }),
      findMany: jest.fn().mockResolvedValue([
        { id: 'u-alex', nome: 'Alex' },
        { id: NOVO_DONO, nome: 'Bruna' },
      ]),
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
  const push: any = { sendToUsers: jest.fn() };
  const assignment: any = { assignBySector: jest.fn() };
  const outboundWebhooks: any = {
    dispatchLeadEvent: jest.fn().mockResolvedValue(undefined),
  };
  const autoActionsQueue: any = { add: jest.fn().mockResolvedValue(undefined) };
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

const NOVO_DONO = '11111111-1111-1111-1111-111111111111';
const OUTRO_LEAD = '22222222-2222-2222-2222-222222222222';
const LEAD_1 = '33333333-3333-3333-3333-333333333333';

const gerente: AuthUser = {
  id: 'u-gerente',
  nome: 'Gestora',
  email: 'gestora@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('reassign — a troca manual de dono deixa rastro', () => {
  it('grava LeadActivity com os nomes dos dois donos, DENTRO da transacao do update', async () => {
    const { service, prisma, txClient } = makeService();

    await service.reassign('lead-1', { novoResponsavelId: NOVO_DONO }, gerente);

    expect(txClient.leadActivity.create).toHaveBeenCalledTimes(1);
    // Fora da transacao seria atividade orfa em caso de rollback.
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
    expect(txClient.leadActivity.create.mock.calls[0][0].data).toEqual({
      lead_id: 'lead-1',
      user_id: 'u-gerente',
      tipo: 'REASSIGNED',
      descricao: 'Reatribuído de Alex para Bruna',
      dados_antes: { responsavel_id: 'u-alex' },
      dados_depois: { responsavel_id: NOVO_DONO },
      tenant_id: 't1',
    });
  });

  it('lead que estava no pool (sem dono anterior) descreve a origem sem quebrar', async () => {
    const { service, prisma, txClient } = makeService();
    prisma.lead.findFirst.mockResolvedValue({
      id: 'lead-1',
      responsavel_id: null,
      responsavel: null,
      instancia_whatsapp: null,
      estagio_id: 'base-novo',
    });

    await service.reassign('lead-1', { novoResponsavelId: NOVO_DONO }, gerente);

    const data = txClient.leadActivity.create.mock.calls[0][0].data;
    expect(data.descricao).toBe('Reatribuído de sem responsável para Bruna');
    expect(data.dados_antes).toEqual({ responsavel_id: null });
  });

  it('update que falha nao deixa atividade: a escrita da auditoria e a mesma transacao', async () => {
    const { service, prisma, txClient } = makeService();
    txClient.lead.update.mockRejectedValue(new Error('erro no update'));

    await expect(
      service.reassign('lead-1', { novoResponsavelId: NOVO_DONO }, gerente),
    ).rejects.toThrow('erro no update');

    // O client da atividade e o `tx`, entao o rollback do Postgres a desfaz.
    // Aqui, com o update ja rejeitado, ela nem chega a ser chamada.
    expect(txClient.leadActivity.create).not.toHaveBeenCalled();
    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });
});

describe('bulkAssign — reatribuicao em massa tambem deixa rastro', () => {
  function comDoisLeads(prisma: any) {
    prisma.lead.findMany.mockResolvedValue([
      { id: LEAD_1, estagio_id: 'base-novo', responsavel_id: 'u-alex' },
      { id: OUTRO_LEAD, estagio_id: 'base-novo', responsavel_id: null },
    ]);
  }

  it('uma atividade por lead, com o dono anterior de CADA um', async () => {
    const { service, prisma } = makeService();
    comDoisLeads(prisma);

    await service.bulkAssign({ ids: [LEAD_1, OUTRO_LEAD], responsavel_id: NOVO_DONO }, gerente);

    expect(prisma.leadActivity.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.leadActivity.createMany.mock.calls[0][0].data).toEqual([
      {
        lead_id: LEAD_1,
        user_id: 'u-gerente',
        tipo: 'REASSIGNED',
        descricao: 'Reatribuído de Alex para Bruna',
        dados_antes: { responsavel_id: 'u-alex' },
        dados_depois: { responsavel_id: NOVO_DONO },
        tenant_id: 't1',
      },
      {
        lead_id: OUTRO_LEAD,
        user_id: 'u-gerente',
        tipo: 'REASSIGNED',
        descricao: 'Reatribuído de sem responsável para Bruna',
        dados_antes: { responsavel_id: null },
        dados_depois: { responsavel_id: NOVO_DONO },
        tenant_id: 't1',
      },
    ]);
  });

  it('kanban individual ligado: mesma auditoria (o caminho da traducao de coluna nao pula o rastro)', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comDoisLeads(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForOwner.mockResolvedValue('col-do-novo-dono');

    await service.bulkAssign({ ids: [LEAD_1, OUTRO_LEAD], responsavel_id: NOVO_DONO }, gerente);

    expect(prisma.leadActivity.createMany).toHaveBeenCalledTimes(1);
    expect(prisma.leadActivity.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('selecao que nao casou nenhum lead do tenant nao grava nada', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findMany.mockResolvedValue([]);

    await service.bulkAssign({ ids: [LEAD_1], responsavel_id: NOVO_DONO }, gerente);

    expect(prisma.leadActivity.createMany).not.toHaveBeenCalled();
  });
});
