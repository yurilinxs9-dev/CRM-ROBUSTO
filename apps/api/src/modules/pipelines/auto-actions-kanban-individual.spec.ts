import { PipelineAutoActionsProcessor } from './auto-actions.processor';
import type { AutoActionJobData } from './auto-actions.processor';
import type { Job } from 'bullmq';

/**
 * Automacao de etapa que ATRIBUI dono (round-robin do `on_entry_config` e
 * `assign_user` do formato legado): com o kanban individual ligado a coluna tem
 * que acompanhar o dono, igual ao `reassign` e ao `bulkAssign`. Sem isso o lead
 * fica parado na coluna de quem NAO e mais o responsavel — o board realoca o
 * card para a primeira coluna do novo dono (nada some da tela), mas a etapa
 * gravada, que e a que SLA, cadencia e segmento de follow-up leem, fica errada.
 *
 * Com o toggle DESLIGADO `stageForOwner` devolve o proprio id, e cada caso tem
 * o par que trava o no-op: escrita identica a de antes da feature.
 */

const ALEX = '11111111-1111-1111-1111-111111111111';

function makeMocks() {
  const prisma: any = {
    stage: { findFirst: jest.fn() },
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'lead-1',
        responsavel_id: null,
        instancia_whatsapp: null,
        telefone: '5511900000000',
        estagio_id: 'base-negociando',
      }),
      update: jest.fn().mockResolvedValue({ id: 'lead-1' }),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: ALEX }]) },
    task: { create: jest.fn().mockResolvedValue({ id: 'task-1', responsavel_id: ALEX }) },
  };
  const gateway: any = { emitTaskCreated: jest.fn(), emitLeadUpdated: jest.fn() };
  const messages: any = { sendText: jest.fn().mockResolvedValue(undefined) };
  // Default = toggle DESLIGADO (traducao identidade), como o service real.
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(false),
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
  };
  return { prisma, gateway, messages, kanbanIndividual };
}

function makeProcessor() {
  const m = makeMocks();
  const processor = new PipelineAutoActionsProcessor(
    m.prisma,
    m.gateway,
    m.messages,
    m.kanbanIndividual,
  );
  return { processor, ...m };
}

const job = {
  data: {
    leadId: 'lead-1',
    newStageId: 'stage-x',
    tenantId: 't1',
    triggeredByUserId: 'u-gerente',
  } satisfies AutoActionJobData,
} as Job<AutoActionJobData>;

/** `data` do unico `lead.update`. */
const dataEscrita = (prisma: any) => prisma.lead.update.mock.calls[0][0].data;

describe('on_entry_config.assignResponsible (round-robin) — a coluna acompanha o sorteado', () => {
  function comAssignResponsible(prisma: any) {
    prisma.stage.findFirst.mockResolvedValue({
      id: 'stage-x',
      auto_action: null,
      on_entry_config: { assignResponsible: { enabled: true } },
    });
  }

  it('toggle ON: a mesma escrita que da o dono leva a coluna dele', async () => {
    const { processor, prisma, kanbanIndividual } = makeProcessor();
    comAssignResponsible(prisma);
    kanbanIndividual.stageForOwner.mockResolvedValue('alex-negociando');

    await processor.process(job);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith('t1', ALEX, 'base-negociando');
    expect(dataEscrita(prisma)).toEqual({
      responsavel_id: ALEX,
      returned_at: null,
      estagio_id: 'alex-negociando',
      estagio_entered_at: expect.any(Date),
    });
  });

  it('toggle OFF: escrita identica a de antes da feature', async () => {
    const { processor, prisma } = makeProcessor();
    comAssignResponsible(prisma);

    await processor.process(job);

    expect(dataEscrita(prisma)).toEqual({ responsavel_id: ALEX, returned_at: null });
  });
});

describe('auto_action legado (on_enter.assign_user) — a coluna acompanha o escolhido', () => {
  function comAssignUser(prisma: any) {
    prisma.stage.findFirst.mockResolvedValue({
      id: 'stage-x',
      auto_action: { on_enter: { assign_user: { user_id: ALEX } } },
      on_entry_config: null,
    });
  }

  it('toggle ON: a mesma escrita que da o dono leva a coluna dele', async () => {
    const { processor, prisma, kanbanIndividual } = makeProcessor();
    comAssignUser(prisma);
    kanbanIndividual.stageForOwner.mockResolvedValue('alex-negociando');

    await processor.process(job);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith('t1', ALEX, 'base-negociando');
    expect(dataEscrita(prisma)).toEqual({
      responsavel_id: ALEX,
      returned_at: null,
      estagio_id: 'alex-negociando',
      estagio_entered_at: expect.any(Date),
    });
  });

  it('toggle OFF: escrita identica a de antes da feature', async () => {
    const { processor, prisma } = makeProcessor();
    comAssignUser(prisma);

    await processor.process(job);

    expect(dataEscrita(prisma)).toEqual({ responsavel_id: ALEX, returned_at: null });
  });
});
