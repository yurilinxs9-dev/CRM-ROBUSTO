import { PublicApiService } from './public-api.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GATE do kanban individual na API publica.
 *
 * Com o toggle ligado o tenant tem N copias de cada coluna (uma por membro,
 * mesmo nome e mesma `ordem`) e o board de cada pessoa so consulta as colunas
 * DELA. Para a integracao isso significa tres coisas:
 *
 * 1. O catalogo de etapas (`GET /pipelines`) tem que ser o MODELO do tenant —
 *    a base. Devolver as copias pessoais faria a integracao guardar o id da
 *    coluna de um membro sorteado e mandar todo mundo para o board dele.
 * 2. Contato criado pela API nasce SEM dono, entao ele pertence a base: a
 *    primeira etapa tem que ser procurada entre as colunas base, senao o
 *    desempate do `ordem` poderia deixa-lo na coluna pessoal de um colega —
 *    board de ninguem.
 * 3. `POST .../stage` recebe um id de coluna vindo do catalogo (base) e move um
 *    lead que PODE ter dono. Sem traduzir para a copia do dono, o lead sumiria
 *    do board de quem cuida dele.
 *
 * Toggle desligado: nada disso existe (nao ha coluna pessoal), e cada caso tem
 * o par que trava o no-op.
 */

const TENANT = 'tenant-1';

const LEAD_DTO = {
  id: 'lead-1',
  nome: 'x',
  telefone: '1',
  email: null,
  tags: [],
  atendimento_status: 'OPEN',
  created_at: new Date('2026-08-07T12:00:00.000Z'),
};

const COLUNA_BASE = 'base-novo';
const COLUNA_DO_DONO = 'alex-novo';

function montar(opts: { kanbanOn?: boolean; lead?: Record<string, unknown> } = {}) {
  const prisma: any = {
    pipeline: {
      findFirst: jest.fn().mockResolvedValue({ id: 'pipe-1', stages: [{ id: COLUNA_BASE }] }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue({ nome: 'inst-1' }) },
    stage: { findFirst: jest.fn().mockResolvedValue({ id: COLUNA_BASE }) },
    lead: {
      findFirst: jest.fn().mockResolvedValue(
        opts.lead ?? { ...LEAD_DTO, responsavel_id: null },
      ),
      create: jest.fn().mockResolvedValue(LEAD_DTO),
      update: jest.fn().mockResolvedValue(LEAD_DTO),
    },
    leadActivity: { create: jest.fn().mockResolvedValue({}) },
  };
  const leads: any = { updateStage: jest.fn().mockResolvedValue(LEAD_DTO) };
  const gateway: any = { emitLeadCreated: jest.fn(), emitLeadUpdated: jest.fn() };
  const customFields: any = { validateValues: jest.fn() };
  const attribution: any = { recordFirstTouch: jest.fn().mockResolvedValue(undefined) };
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(opts.kanbanOn ?? false),
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
  };
  const svc = new PublicApiService(
    prisma,
    {} as any,
    leads,
    gateway,
    customFields,
    attribution,
    kanbanIndividual,
  );
  return { svc, prisma, leads, kanbanIndividual };
}

describe('PublicApiService.listPipelines — catalogo de etapas', () => {
  it('toggle ON: devolve so as colunas BASE (o modelo do tenant)', async () => {
    const { svc, prisma } = montar({ kanbanOn: true });

    await svc.listPipelines(TENANT);

    expect(prisma.pipeline.findMany.mock.calls[0][0].select.stages.where).toEqual({
      user_id: null,
    });
  });

  it('toggle OFF: consulta identica a de antes da feature (sem filtro de dono)', async () => {
    const { svc, prisma } = montar({ kanbanOn: false });

    await svc.listPipelines(TENANT);

    expect(prisma.pipeline.findMany.mock.calls[0][0].select.stages.where).toBeUndefined();
  });
});

describe('PublicApiService.createContact — primeira etapa', () => {
  it('toggle ON: a primeira etapa sai do conjunto BASE', async () => {
    const { svc, prisma } = montar({ kanbanOn: true });

    await svc.createContact(TENANT, { name: 'Fulano', phone: '5531999999999' });

    expect(prisma.pipeline.findFirst.mock.calls[0][0].select.stages.where).toEqual({
      user_id: null,
    });
  });

  it('toggle OFF: consulta identica a de antes da feature', async () => {
    const { svc, prisma } = montar({ kanbanOn: false });

    await svc.createContact(TENANT, { name: 'Fulano', phone: '5531999999999' });

    expect(prisma.pipeline.findFirst.mock.calls[0][0].select.stages.where).toBeUndefined();
  });
});

describe('PublicApiService.moveStage — a coluna acompanha o dono do lead', () => {
  const STAGE_PEDIDO = '11111111-1111-1111-1111-111111111111';

  it('toggle ON + lead com dono: move para a copia do DONO', async () => {
    const { svc, leads, kanbanIndividual } = montar({
      kanbanOn: true,
      lead: { ...LEAD_DTO, responsavel_id: 'u-alex' },
    });
    kanbanIndividual.stageForOwner.mockResolvedValue(COLUNA_DO_DONO);

    await svc.moveStage(TENANT, 'lead-1', { stage_id: STAGE_PEDIDO });

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith(TENANT, 'u-alex', STAGE_PEDIDO);
    expect(leads.updateStage.mock.calls[0][1]).toEqual({ estagio_id: COLUNA_DO_DONO });
  });

  it('toggle ON + lead sem dono: cai na BASE, nunca na coluna de um membro', async () => {
    const { svc, leads, kanbanIndividual } = montar({
      kanbanOn: true,
      lead: { ...LEAD_DTO, responsavel_id: null },
    });
    kanbanIndividual.stageForBase.mockResolvedValue(COLUNA_BASE);

    await svc.moveStage(TENANT, 'lead-1', { stage_id: STAGE_PEDIDO });

    expect(kanbanIndividual.stageForBase).toHaveBeenCalledWith(TENANT, STAGE_PEDIDO);
    expect(leads.updateStage.mock.calls[0][1]).toEqual({ estagio_id: COLUNA_BASE });
  });

  it('toggle OFF: manda o id cru, sem nenhuma traducao', async () => {
    const { svc, leads, kanbanIndividual } = montar({
      kanbanOn: false,
      lead: { ...LEAD_DTO, responsavel_id: 'u-alex' },
    });

    await svc.moveStage(TENANT, 'lead-1', { stage_id: STAGE_PEDIDO });

    expect(kanbanIndividual.stageForOwner).not.toHaveBeenCalled();
    expect(kanbanIndividual.stageForBase).not.toHaveBeenCalled();
    expect(leads.updateStage.mock.calls[0][1]).toEqual({ estagio_id: STAGE_PEDIDO });
  });
});
