import { NotFoundException } from '@nestjs/common';
import { PublicApiService } from './public-api.service';

/**
 * Reincidência: a mesma pessoa preenche o formulário duas vezes (viu o anúncio
 * de novo). No Kommo isso virava um lead NOVO reaproveitando o contato — aqui
 * não pode, porque `@@unique([telefone, pipeline_id, lead_scope])` garante um
 * lead por pessoa por funil.
 *
 * A saída é devolver o lead existente ao topo do funil e anotar a passagem.
 * Estes testes travam as três formas de isso dar errado em silêncio:
 *
 * 1. Mover o lead por `prisma.lead.update` direto, pulando o `updateStage` —
 *    perderia atividade, auto-ações, reset de `estagio_entered_at`, cache e o
 *    evento de WebSocket que faz o card andar na tela de quem está com o Kanban
 *    aberto.
 * 2. Aceitar `stage_id` de outro tenant, jogando o lead num funil alheio.
 * 3. Zerar o contador de não-lidas ao mover — mover por integração não
 *    significa que alguém leu a conversa.
 */

const TENANT = 'tenant-1';
const OUTRO_TENANT = 'tenant-2';
const LEAD_ID = '11111111-1111-1111-1111-111111111111';
const STAGE_ID = '22222222-2222-2222-2222-222222222222';

const LEAD_DTO = {
  id: LEAD_ID,
  nome: 'Fulano',
  telefone: '5531999999999',
  email: null,
  tags: [],
  atendimento_status: 'OPEN',
  created_at: new Date('2026-08-07T12:00:00.000Z'),
};

function makeService(over: Record<string, unknown> = {}) {
  const prisma = {
    lead: { findFirst: jest.fn().mockResolvedValue(LEAD_DTO) },
    stage: { findFirst: jest.fn().mockResolvedValue({ id: STAGE_ID }) },
    leadActivity: {
      create: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({
          id: 'act-1',
          tipo: data.tipo,
          descricao: data.descricao,
          created_at: new Date('2026-08-07T12:00:00.000Z'),
        }),
      ),
    },
    pipeline: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as unknown as ConstructorParameters<typeof PublicApiService>[0];

  const leads = { updateStage: jest.fn().mockResolvedValue({}) } as unknown as ConstructorParameters<
    typeof PublicApiService
  >[2];

  const svc = new PublicApiService(
    prisma,
    {} as ConstructorParameters<typeof PublicApiService>[1],
    leads,
    { emitLeadUpdated: jest.fn() } as unknown as ConstructorParameters<typeof PublicApiService>[3],
    {} as ConstructorParameters<typeof PublicApiService>[4],
    {
      recordFirstTouch: jest.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof PublicApiService>[5],
  );
  return { svc, prisma: prisma as never, leads: leads as never };
}

const mockDe = (obj: unknown, caminho: string) =>
  (obj as Record<string, Record<string, jest.Mock>>)[caminho.split('.')[0]][
    caminho.split('.')[1]
  ];

describe('PublicApiService — mover de estagio', () => {
  it('delega para LeadsService.updateStage, nao escreve no lead direto', async () => {
    const { svc, leads } = makeService();

    await svc.moveStage(TENANT, LEAD_ID, { stage_id: STAGE_ID });

    const chamada = (leads as unknown as { updateStage: jest.Mock }).updateStage.mock.calls[0];
    expect(chamada[0]).toBe(LEAD_ID);
    expect(chamada[1]).toEqual({ estagio_id: STAGE_ID });
  });

  /**
   * `SYSTEM` não é detalhe: é a convenção que o updateStage já entende para
   * ação não-humana. Com um id de usuário real, o contador de não-lidas seria
   * zerado — a integração diria "alguém leu" sem ninguém ter lido.
   */
  it('assina a acao como SYSTEM, no tenant certo', async () => {
    const { svc, leads } = makeService();

    await svc.moveStage(TENANT, LEAD_ID, { stage_id: STAGE_ID });

    const user = (leads as unknown as { updateStage: jest.Mock }).updateStage.mock.calls[0][2];
    expect(user.id).toBe('SYSTEM');
    expect(user.tenantId).toBe(TENANT);
  });

  it('lead de outro tenant vira 404 e nao move nada', async () => {
    const { svc, leads } = makeService({ lead: { findFirst: jest.fn().mockResolvedValue(null) } });

    await expect(svc.moveStage(TENANT, LEAD_ID, { stage_id: STAGE_ID })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((leads as unknown as { updateStage: jest.Mock }).updateStage).not.toHaveBeenCalled();
  });

  /** Sem esta checagem, um stage_id alheio jogaria o lead em outro funil. */
  it('estagio de outro tenant vira 404 e nao move nada', async () => {
    const { svc, leads } = makeService({ stage: { findFirst: jest.fn().mockResolvedValue(null) } });

    await expect(svc.moveStage(TENANT, LEAD_ID, { stage_id: STAGE_ID })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((leads as unknown as { updateStage: jest.Mock }).updateStage).not.toHaveBeenCalled();
  });

  it('confere o estagio dentro do tenant de quem chamou', async () => {
    const { svc, prisma } = makeService();

    await svc.moveStage(TENANT, LEAD_ID, { stage_id: STAGE_ID });

    const where = mockDe(prisma, 'stage.findFirst').mock.calls[0][0].where;
    expect(where).toEqual({ id: STAGE_ID, tenant_id: TENANT });
    expect(where.tenant_id).not.toBe(OUTRO_TENANT);
  });

  it('stage_id que nao e uuid e recusado antes de qualquer consulta', async () => {
    const { svc, prisma } = makeService();

    await expect(svc.moveStage(TENANT, LEAD_ID, { stage_id: 'nao-e-uuid' })).rejects.toBeTruthy();
    expect(mockDe(prisma, 'lead.findFirst')).not.toHaveBeenCalled();
  });
});

describe('PublicApiService — anotacao na timeline', () => {
  it('grava no lead e no tenant certos, sem usuario', async () => {
    const { svc, prisma } = makeService();

    await svc.createActivity(TENANT, LEAD_ID, { descricao: 'Preencheu o formulario de novo' });

    const data = mockDe(prisma, 'leadActivity.create').mock.calls[0][0].data;
    expect(data.lead_id).toBe(LEAD_ID);
    expect(data.tenant_id).toBe(TENANT);
    // Quem escreveu foi uma integração, não uma pessoa.
    expect(data.user_id).toBeNull();
  });

  it('tipo default e api_note, mas aceita o do chamador', async () => {
    const { svc, prisma } = makeService();

    await svc.createActivity(TENANT, LEAD_ID, { descricao: 'x' });
    expect(mockDe(prisma, 'leadActivity.create').mock.calls[0][0].data.tipo).toBe('api_note');

    await svc.createActivity(TENANT, LEAD_ID, { descricao: 'x', tipo: 'form_resubmit' });
    expect(mockDe(prisma, 'leadActivity.create').mock.calls[1][0].data.tipo).toBe('form_resubmit');
  });

  it('lead de outro tenant vira 404 e nao grava atividade', async () => {
    const { svc, prisma } = makeService({ lead: { findFirst: jest.fn().mockResolvedValue(null) } });

    await expect(svc.createActivity(TENANT, LEAD_ID, { descricao: 'x' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockDe(prisma, 'leadActivity.create')).not.toHaveBeenCalled();
  });

  it('descricao vazia e recusada', async () => {
    const { svc } = makeService();
    await expect(svc.createActivity(TENANT, LEAD_ID, { descricao: '' })).rejects.toBeTruthy();
  });
});
