import { PublicApiService } from './public-api.service';

/**
 * `dados_custom` na API pública é o que permite a um fluxo de integração (n8n,
 * formulário) gravar as respostas do lead, e não só nome/telefone/e-mail.
 * Três coisas que quebram em silêncio se alguém mexer:
 *
 * 1. Não validar. O valor viria cru para a coluna Json e apareceria torto na
 *    ficha depois — longe, no tempo e no lugar, de quem mandou.
 * 2. Não passar `fromPublicApi`. Campo marcado "Apenas API" seria recusado
 *    justamente pela API, que é o único lugar onde ele deveria ser gravável.
 * 3. Substituir em vez de mesclar no PATCH. O corpo manda só o que mudou;
 *    trocar o Json inteiro apagaria todo o resto sem erro nenhum.
 */

const TENANT = 'tenant-1';

/** O serializer público exige created_at como Date e atendimento_status. */
const LEAD_DTO = {
  id: 'lead-1',
  nome: 'x',
  telefone: '1',
  email: null,
  tags: [],
  atendimento_status: 'OPEN',
  created_at: new Date('2026-08-07T12:00:00.000Z'),
};

function makeService(over: Record<string, unknown> = {}) {
  const prisma = {
    pipeline: {
      findFirst: jest.fn().mockResolvedValue({ id: 'pipe-1', stages: [{ id: 'stage-1' }] }),
    },
    whatsappInstance: { findFirst: jest.fn().mockResolvedValue({ nome: 'inst-1' }) },
    lead: {
      findFirst: jest.fn().mockResolvedValue({ id: 'lead-1', dados_custom: {} }),
      create: jest.fn().mockResolvedValue(LEAD_DTO),
      update: jest.fn().mockResolvedValue(LEAD_DTO),
    },
    leadActivity: { create: jest.fn().mockResolvedValue({}) },
    customFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
    ...over,
  } as unknown as ConstructorParameters<typeof PublicApiService>[0];

  const customFields = {
    validateValues: jest.fn().mockImplementation((v: Record<string, unknown>) => Promise.resolve(v)),
  } as unknown as ConstructorParameters<typeof PublicApiService>[4];

  const gateway = {
    emitLeadUpdated: jest.fn(),
    emitLeadCreated: jest.fn(),
  } as unknown as ConstructorParameters<typeof PublicApiService>[3];

  const svc = new PublicApiService(
    prisma,
    {} as ConstructorParameters<typeof PublicApiService>[1],
    {} as ConstructorParameters<typeof PublicApiService>[2],
    gateway,
    customFields,
    {
      recordFirstTouch: jest.fn().mockResolvedValue(undefined),
    } as unknown as ConstructorParameters<typeof PublicApiService>[5],
    {
      isOn: jest.fn().mockResolvedValue(false),
      stageForOwner: jest.fn(),
      stageForBase: jest.fn(),
    } as unknown as ConstructorParameters<typeof PublicApiService>[6],
  );
  return { svc, prisma: prisma as never, customFields: customFields as never };
}

describe('PublicApiService — dados_custom', () => {
  it('createContact valida antes de gravar, com fromPublicApi ligado', async () => {
    const { svc, customFields } = makeService();

    await svc.createContact(TENANT, {
      name: 'Fulano',
      phone: '5531999999999',
      dados_custom: { cidade: 'BH' },
    });

    const chamada = (customFields as unknown as { validateValues: jest.Mock }).validateValues.mock
      .calls[0];
    expect(chamada[0]).toEqual({ cidade: 'BH' });
    expect(chamada[1]).toBe(TENANT);
    expect(chamada[2]).toBe('LEAD');
    // Sem esta flag, campo "Apenas API" seria recusado pela propria API.
    expect(chamada[3]).toEqual({ fromPublicApi: true });
  });

  it('createContact sem dados_custom nao chama a validacao nem grava a chave', async () => {
    const { svc, prisma, customFields } = makeService();

    await svc.createContact(TENANT, { name: 'Fulano', phone: '5531999999999' });

    expect(
      (customFields as unknown as { validateValues: jest.Mock }).validateValues,
    ).not.toHaveBeenCalled();
    const data = (prisma as unknown as { lead: { create: jest.Mock } }).lead.create.mock.calls[0][0]
      .data;
    expect('dados_custom' in data).toBe(false);
  });

  /** O teste que importa: PATCH parcial não pode apagar o que não veio no corpo. */
  it('updateContact MESCLA com o que ja estava gravado, nao substitui', async () => {
    const { svc, prisma } = makeService({
      lead: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'lead-1',
          dados_custom: { cidade: 'BH', modelo: 'Onix 2020' },
        }),
        update: jest.fn().mockResolvedValue(LEAD_DTO),
      },
    });

    await svc.updateContact(TENANT, 'lead-1', { dados_custom: { modelo: 'Onix 2022' } });

    const data = (prisma as unknown as { lead: { update: jest.Mock } }).lead.update.mock
      .calls[0][0].data;
    expect(data.dados_custom).toEqual({ cidade: 'BH', modelo: 'Onix 2022' });
  });

  /**
   * O lead criado pela integração nasce sem mensagem e sem mudança de estágio,
   * que eram os únicos eventos que o Kanban escutava. Sem este emit, o card só
   * aparecia no poll de 60s — e quem estava olhando a tela concluía que a
   * automação não tinha rodado.
   */
  it('createContact avisa o Kanban por WebSocket', async () => {
    const { svc, customFields } = makeService();
    void customFields;

    await svc.createContact(TENANT, { name: 'Fulano', phone: '5531999999999' });

    const gw = (svc as unknown as { gateway: { emitLeadCreated: jest.Mock } }).gateway;
    expect(gw.emitLeadCreated).toHaveBeenCalledTimes(1);
    expect(gw.emitLeadCreated.mock.calls[0][2]).toBe(TENANT);
  });

  it('listCustomFields devolve so os campos de LEAD ativos e nao-nativos do tenant', async () => {
    const { svc, prisma } = makeService();

    await svc.listCustomFields(TENANT);

    expect(
      (prisma as unknown as { customFieldDef: { findMany: jest.Mock } }).customFieldDef.findMany.mock
        .calls[0][0].where,
    ).toEqual({ tenant_id: TENANT, active: true, escopo: 'LEAD', native_key: null });
  });
});
