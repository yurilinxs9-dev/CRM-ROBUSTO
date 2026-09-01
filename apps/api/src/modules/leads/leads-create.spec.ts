import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Bug: o dialogo "Nova conversa" do chat manda { nome, telefone, estagio_id,
 * temperatura }, sem pipeline_id nem instancia_whatsapp. O schema antigo
 * exigia os dois (uuid obrigatorio) — Zod rejeitava 100% das criacoes com
 * 400. Fix: pipeline_id e instancia_whatsapp viram opcionais no schema e sao
 * DERIVADOS no backend (mesma regra do webhook inbound para o pipeline
 * default; mesma nocao de "instancia viva" do messages.service para o modo
 * compartilhado).
 *
 * Bug #2 (tenants com mais de um pipeline): a correcao acima resolvia
 * pipeline_id ausente SEMPRE para o pipeline default do tenant, mesmo quando
 * estagio_id apontava para outro pipeline — o Kanban manda so estagio_id
 * (nunca soube do pipeline_id), entao criar lead numa coluna de um pipeline
 * nao-default sempre caia em "Estagio nao pertence ao pipeline selecionado".
 * Fix: Stage e a fonte de verdade do proprio pipeline_id. resolvePipelineAndStage
 * agora deriva pipeline_id do estagio informado quando pipeline_id esta
 * ausente (nunca o contrario) — ver precedencia no service.
 */

function makeMocks() {
  const prisma: any = {
    tenant: { findFirst: jest.fn() },
    pipeline: { findFirst: jest.fn(), create: jest.fn() },
    stage: { findFirst: jest.fn() },
    whatsappInstance: { findFirst: jest.fn() },
    lead: {
      // Lead novo entra no topo da coluna: o service pergunta a MENOR position
      // do estágio e grava uma abaixo dela. Coluna vazia → _min.position null.
      aggregate: jest.fn().mockResolvedValue({ _min: { position: null } }),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-new-1', ...data }),
      ),
      // Dedupe lookup (telefone+pipeline_id+lead_scope). Default: nenhum
      // lead existente — testes de duplicata sobrescrevem com
      // mockResolvedValueOnce.
      findFirst: jest.fn().mockResolvedValue(null),
    },
    leadActivity: { create: jest.fn().mockResolvedValue({}) },
    // create() usa $transaction em modo ARRAY: [this.prisma.lead.create(...)].
    // As promises ja foram construidas antes de chegar aqui — só precisamos
    // resolve-las e devolver o array de resultados.
    $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  const cache: any = { delPattern: jest.fn() };
  const gateway: any = { emitLeadUpdated: jest.fn(), emitLeadCreated: jest.fn() };
  const outboundWebhooks: any = {
    dispatchLeadEvent: jest.fn().mockReturnValue(Promise.resolve()),
  };
  // Default = kanban individual DESLIGADO, que e o estado de quase todo tenant:
  // as duas traducoes de coluna sao identidade, como no service real.
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(false),
    stageForOwner: jest.fn(async (_t: string, _o: string, from: string) => from),
    stageForBase: jest.fn(async (_t: string, from: string) => from),
  };
  return { prisma, cache, gateway, outboundWebhooks, kanbanIndividual };
}

function makeService() {
  const m = makeMocks();
  const service = new LeadsService(
    m.prisma,
    {} as any, // InstancesService — nao usado por create()
    m.cache,
    m.gateway,
    {} as any, // MediaService
    {} as any, // PushService
    m.outboundWebhooks,
    {} as any, // AssignmentService
    {} as any, // CustomFieldsService
    {} as any, // autoActionsQueue (BullMQ)
    m.kanbanIndividual,
  );
  return { service, ...m };
}

const operador: AuthUser = {
  id: 'u-operador',
  nome: 'Operador',
  email: 'op@x.com',
  role: UserRole.OPERADOR as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

const ESTAGIO_ID = '22222222-2222-2222-2222-222222222222';
const DEFAULT_PIPELINE_ID = '99999999-9999-9999-9999-999999999999';
const OWN_INSTANCE_NAME = 'inst-alex-personal-007';

// Multi-pipeline fixtures — valores distintos e reconhecíveis, nunca
// reaproveitados como "o valor certo por coincidência".
const NON_DEFAULT_PIPELINE_ID = '77777777-7777-7777-7777-777777777777';
const STAGE_IN_NON_DEFAULT_PIPELINE = '66666666-6666-6666-6666-666666666666';
const FOREIGN_TENANT_ESTAGIO_ID = '55555555-5555-5555-5555-555555555555';
const FIRST_STAGE_OF_DEFAULT_PIPELINE = '44444444-4444-4444-4444-444444444444';

describe('LeadsService.create — deriva pipeline_id e instancia_whatsapp quando ausentes', () => {
  it('sem pipeline_id e sem instancia_whatsapp: usa o pipeline do proprio estagio (unico do tenant) e a instancia propria do criador', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    // Tenant so tem esse pipeline — stage.findFirst (tenant-scoped, sem
    // filtro de pipeline) e quem devolve o pipeline_id agora.
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID, pipeline_id: DEFAULT_PIPELINE_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });

    await service.create(
      { nome: 'Novo Contato', telefone: '+5531999999999', estagio_id: ESTAGIO_ID, temperatura: 'FRIO' },
      operador,
    );

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    const payload = prisma.lead.create.mock.calls[0][0].data;
    expect(payload.pipeline_id).toBe(DEFAULT_PIPELINE_ID);
    expect(payload.instancia_whatsapp).toBe(OWN_INSTANCE_NAME);
  });

  it('estagio_id vazio ("") e tratado como ausente, nao como uuid invalido', async () => {
    // Formulario React controlado inicia campo nao preenchido como '', nunca
    // como undefined. new-chat-dialog.tsx faz useState('') e manda assim. O
    // .uuid().optional() aceitava ausente mas rejeitava '' — 400 sem dizer
    // qual campo era. Em producao deu 8 VALIDATION_ERROR seguidos.
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    prisma.stage.findFirst.mockResolvedValue({
      id: FIRST_STAGE_OF_DEFAULT_PIPELINE,
      pipeline_id: DEFAULT_PIPELINE_ID,
    });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });

    await service.create(
      { nome: 'Sem Etapa', telefone: '+5531988887777', estagio_id: '', pipeline_id: '', temperatura: 'FRIO' },
      operador,
    );

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    const payload = prisma.lead.create.mock.calls[0][0].data;
    expect(payload.pipeline_id).toBe(DEFAULT_PIPELINE_ID);
    expect(payload.estagio_id).toBe(FIRST_STAGE_OF_DEFAULT_PIPELINE);
  });

  it('aceita pipeline_id legado que nao e uuid ("pipeline-default")', async () => {
    // Producao tem 1 pipeline de 39 com id "pipeline-default", resquicio de
    // seed antigo, com stages e leads reais apontando pra ele. O Kanban manda
    // esse id corretamente; era o z.string().uuid() que rejeitava, e o log so
    // dizia "Validation failed" sem citar o campo.
    const LEGACY_PIPELINE_ID = 'pipeline-default';
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.stage.findFirst.mockResolvedValue({
      id: ESTAGIO_ID,
      pipeline_id: LEGACY_PIPELINE_ID,
    });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });

    await service.create(
      {
        nome: 'Lead Pipeline Legado',
        telefone: '+5531977776666',
        estagio_id: ESTAGIO_ID,
        pipeline_id: LEGACY_PIPELINE_ID,
        temperatura: 'FRIO',
      },
      operador,
    );

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    expect(prisma.lead.create.mock.calls[0][0].data.pipeline_id).toBe(LEGACY_PIPELINE_ID);
  });

  /**
   * Regra invertida de proposito. Antes, criar lead sem numero conectado dava
   * BadRequestException — e o efeito era que um tenant sem WhatsApp nao
   * conseguia usar o CRM como CRM: 18 dos 38 tenants em producao estavam nessa
   * situacao. Existe empresa que quer so o funil, sem chat.
   *
   * WhatsApp e requisito para ENVIAR MENSAGEM, nao para cadastrar lead. Essa
   * verificacao vive em messages.service, que ja resolve instancia com fallback
   * e recusa o envio com mensagem propria quando nao ha nenhuma.
   */
  it('modo Individual sem instancia conectada: CRIA o lead, com instancia vazia', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue(null);

    await service.create(
      { nome: 'Novo Contato', telefone: '+5531999999999', estagio_id: ESTAGIO_ID },
      operador,
    );

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    expect(prisma.lead.create.mock.calls[0][0].data.instancia_whatsapp).toBe('');
  });

  it('modo Compartilhado sem nenhuma instancia viva: tambem cria', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue(null);

    await service.create(
      { nome: 'Novo Contato', telefone: '+5531999999999', estagio_id: ESTAGIO_ID },
      operador,
    );

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    expect(prisma.lead.create.mock.calls[0][0].data.instancia_whatsapp).toBe('');
  });

  it('modo Compartilhado: resolve uma instancia VIVA do tenant, nao a do usuario', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: true });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-shared-1',
      nome: 'inst-shared-live-42',
      owner_user_id: 'someone-else',
      status: 'connected',
    });

    await service.create(
      {
        nome: 'Novo Contato',
        telefone: '+5531999999999',
        // pipeline_id explicito aqui: isola o teste da resolucao de default,
        // o foco e a resolucao de instancia em modo compartilhado.
        pipeline_id: DEFAULT_PIPELINE_ID,
        estagio_id: ESTAGIO_ID,
      },
      operador,
    );

    // A busca em modo compartilhado nao pode filtrar por owner_user_id — senao
    // estaria pegando a instancia do usuario, nao "qualquer instancia viva".
    const call = prisma.whatsappInstance.findFirst.mock.calls[0][0];
    expect(call.where).not.toHaveProperty('owner_user_id');
    expect(call.where.status).toEqual({ in: expect.arrayContaining(['open', 'connected', 'connecting']) });

    const payload = prisma.lead.create.mock.calls[0][0].data;
    expect(payload.instancia_whatsapp).toBe('inst-shared-live-42');
  });

  it('pipeline_id explicito + estagio_id de OUTRO pipeline: rejeitado com BadRequestException (caller autoritativo nao e contornado)', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    // stage.findFirst filtrado por { id, pipeline_id: DEFAULT_PIPELINE_ID, tenant_id }
    // nao encontra nada — o estagio de verdade pertence a NON_DEFAULT_PIPELINE_ID.
    prisma.stage.findFirst.mockResolvedValue(null);

    await expect(
      service.create(
        {
          nome: 'Novo Contato',
          telefone: '+5531999999999',
          pipeline_id: DEFAULT_PIPELINE_ID,
          estagio_id: STAGE_IN_NON_DEFAULT_PIPELINE,
        },
        operador,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('sem pipeline_id, estagio_id de um pipeline NAO-default: cria no pipeline DO ESTAGIO, nunca no default do tenant (bug multi-pipeline)', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    // Estagio pertence a um pipeline que NAO e o default — so a lookup
    // tenant-scoped do proprio estagio pode revelar isso.
    prisma.stage.findFirst.mockResolvedValue({
      id: STAGE_IN_NON_DEFAULT_PIPELINE,
      pipeline_id: NON_DEFAULT_PIPELINE_ID,
    });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });

    await service.create(
      {
        nome: 'Novo Contato',
        telefone: '+5531999999999',
        estagio_id: STAGE_IN_NON_DEFAULT_PIPELINE,
        temperatura: 'FRIO',
      },
      operador,
    );

    // Nunca deveria ter tentado resolver o pipeline default — o proprio
    // estagio ja revela o pipeline.
    expect(prisma.pipeline.findFirst).not.toHaveBeenCalled();
    const payload = prisma.lead.create.mock.calls[0][0].data;
    expect(payload.pipeline_id).toBe(NON_DEFAULT_PIPELINE_ID);
    expect(payload.pipeline_id).not.toBe(DEFAULT_PIPELINE_ID);
    expect(payload.estagio_id).toBe(STAGE_IN_NON_DEFAULT_PIPELINE);
  });

  it('estagio_id de OUTRO tenant: rejeitado com NotFoundException, nunca cai silenciosamente no pipeline default', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    // stage.findFirst e tenant-scoped (id + tenant_id) — um estagio real de
    // outro tenant nunca aparece nessa query, simulado aqui como null.
    prisma.stage.findFirst.mockResolvedValue(null);

    await expect(
      service.create(
        { nome: 'Novo Contato', telefone: '+5531999999999', estagio_id: FOREIGN_TENANT_ESTAGIO_ID },
        operador,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
    // Nao deve ter tentado um fallback silencioso pro pipeline default.
    expect(prisma.pipeline.findFirst).not.toHaveBeenCalled();
  });

  it('nem pipeline_id nem estagio_id: usa pipeline default do tenant + seu primeiro estagio (guarda contra regressao)', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    prisma.stage.findFirst.mockResolvedValue({ id: FIRST_STAGE_OF_DEFAULT_PIPELINE });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });

    await service.create(
      { nome: 'Novo Contato', telefone: '+5531999999999', temperatura: 'FRIO' },
      operador,
    );

    const payload = prisma.lead.create.mock.calls[0][0].data;
    expect(payload.pipeline_id).toBe(DEFAULT_PIPELINE_ID);
    expect(payload.estagio_id).toBe(FIRST_STAGE_OF_DEFAULT_PIPELINE);
  });
});

/**
 * Bug: telefone duplicado no mesmo (pipeline_id, lead_scope) — exatamente a
 * tupla da unique constraint `telefone_pipeline_scope` — estourava P2002, que
 * o exception filter traduzia para "Resource already exists". Mensagem nao
 * dizia nada e nao dava caminho pra frente. Em producao o dono contornou
 * mudando um digito do telefone, criando um segundo contato com numero
 * ERRADO para a mesma pessoa.
 *
 * Decisao do product owner: quem digita um telefone que ja existe quase
 * sempre quer falar com aquela pessoa, nao criar um segundo registro. Fix:
 * devolve o lead existente em vez de falhar, e deixa o front navegar pra ele.
 *
 * Match e SOMENTE no valor exato armazenado (parsed.telefone) — o mesmo
 * string que iria pro insert. Fuzzy match entre formatos de telefone NAO e
 * feito de proposito: este tenant tem a MESMA pessoa sob dois formatos
 * distintos (553791048239 e +5537991048239) — mesclar por heuristica arrisca
 * juntar contatos diferentes, uma falha pior que a que este fix resolve.
 */
describe('LeadsService.create — telefone duplicado no mesmo pipeline devolve o lead existente', () => {
  const EXISTING_LEAD_ID = 'lead-existing-dupe-ULTRA-777';
  const TELEFONE_DUPLICADO = '+5531955554444';

  it('telefone ja existe no mesmo pipeline e scope: devolve o lead existente com already_existed=true e NUNCA chama lead.create', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID, pipeline_id: DEFAULT_PIPELINE_ID });
    prisma.lead.findFirst.mockResolvedValueOnce({
      id: EXISTING_LEAD_ID,
      telefone: TELEFONE_DUPLICADO,
      pipeline_id: DEFAULT_PIPELINE_ID,
      lead_scope: operador.tenantId,
      nome: 'Contato Existente',
    });

    const result = await service.create(
      { nome: 'Novo Contato', telefone: TELEFONE_DUPLICADO, estagio_id: ESTAGIO_ID, temperatura: 'FRIO' },
      operador,
    );

    expect(result.id).toBe(EXISTING_LEAD_ID);
    expect((result as unknown as { already_existed: boolean }).already_existed).toBe(true);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });

  it('mesmo telefone mas em pipeline DIFERENTE: cria normalmente, already_existed=false', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    // pipeline_id explicito + estagio_id do proprio pipeline (nao-default) —
    // isola o teste da resolucao de pipeline default.
    prisma.stage.findFirst.mockResolvedValue({ id: STAGE_IN_NON_DEFAULT_PIPELINE });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });
    // Dedupe lookup: nenhum lead com esse telefone NESSE pipeline (o dup
    // fixture mora em DEFAULT_PIPELINE_ID, nao em NON_DEFAULT_PIPELINE_ID) —
    // constraint e por-pipeline, colapsar isso bloquearia criacao legitima.
    prisma.lead.findFirst.mockResolvedValueOnce(null);

    const result = await service.create(
      {
        nome: 'Novo Contato',
        telefone: TELEFONE_DUPLICADO,
        pipeline_id: NON_DEFAULT_PIPELINE_ID,
        estagio_id: STAGE_IN_NON_DEFAULT_PIPELINE,
        temperatura: 'FRIO',
      },
      operador,
    );

    expect(prisma.lead.create).toHaveBeenCalledTimes(1);
    expect((result as unknown as { already_existed: boolean }).already_existed).toBe(false);
    // Confirma que a checagem de dedupe foi escopada ao pipeline certo.
    const dedupeCall = prisma.lead.findFirst.mock.calls[0][0];
    expect(dedupeCall.where.pipeline_id).toBe(NON_DEFAULT_PIPELINE_ID);
  });

  it('P2002 na criacao (corrida entre duas requests simultaneas): rele o lead conflitante e devolve, sem lancar excecao', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID, pipeline_id: DEFAULT_PIPELINE_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });
    // 1ª leitura (pre-check): nao ha duplicata ainda — outra request ainda
    // nao commitou. 2ª leitura (pos-catch do P2002): a request concorrente ja
    // commitou, e o lead conflitante aparece.
    prisma.lead.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: EXISTING_LEAD_ID,
        telefone: TELEFONE_DUPLICADO,
        pipeline_id: DEFAULT_PIPELINE_ID,
        lead_scope: operador.tenantId,
        nome: 'Contato Existente',
      });
    const p2002 = Object.assign(new Error('Unique constraint failed on the fields: (`telefone`,`pipeline_id`,`lead_scope`)'), {
      code: 'P2002',
    });
    prisma.lead.create.mockImplementationOnce(() => Promise.reject(p2002));

    const result = await service.create(
      { nome: 'Novo Contato', telefone: TELEFONE_DUPLICADO, estagio_id: ESTAGIO_ID, temperatura: 'FRIO' },
      operador,
    );

    expect(result.id).toBe(EXISTING_LEAD_ID);
    expect((result as unknown as { already_existed: boolean }).already_existed).toBe(true);
  });

  it('devolver lead existente NAO grava LeadActivity (nada foi criado)', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID, pipeline_id: DEFAULT_PIPELINE_ID });
    prisma.lead.findFirst.mockResolvedValueOnce({
      id: EXISTING_LEAD_ID,
      telefone: TELEFONE_DUPLICADO,
      pipeline_id: DEFAULT_PIPELINE_ID,
      lead_scope: operador.tenantId,
      nome: 'Contato Existente',
    });

    await service.create(
      { nome: 'Novo Contato', telefone: TELEFONE_DUPLICADO, estagio_id: ESTAGIO_ID, temperatura: 'FRIO' },
      operador,
    );

    expect(prisma.leadActivity.create).not.toHaveBeenCalled();
  });
});

/**
 * GATE do kanban individual: lead criado a mao nascia INVISIVEL.
 *
 * Duas metades do mesmo furo, que so fazem sentido juntas:
 *
 * 1. A escolha da PRIMEIRA etapa (sem estagio_id explicito) nao filtrava
 *    `user_id: null`. Com o toggle ligado o tenant tem N copias de cada coluna
 *    (uma por membro) com a MESMA `ordem`, entao o `orderBy: ordem asc`
 *    desempatava sozinho e o lead podia nascer na coluna pessoal de um colega
 *    sorteado — board de ninguem.
 * 2. Resolvida a base, o lead ainda nasce COM dono (o criador, fora do modo
 *    pool). Lead com dono parado numa coluna BASE nao aparece no board do dono:
 *    o board dele so consulta as colunas dele. A etapa tem que ser remapeada
 *    para a copia do dono ANTES da gravacao.
 *
 * Toggle desligado: nenhuma das duas coisas acontece — nao existe coluna
 * pessoal, e qualquer filtro/traducao a mais seria mudanca de comportamento
 * num tenant que nem ligou a feature.
 */
describe('LeadsService.create — kanban individual: o lead nasce onde o dono enxerga', () => {
  const COLUNA_BASE = FIRST_STAGE_OF_DEFAULT_PIPELINE;
  const COLUNA_DO_DONO = '33333333-3333-3333-3333-333333333333';

  function comPipelineDefault(prisma: any, poolEnabled = false) {
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: poolEnabled });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    prisma.stage.findFirst.mockResolvedValue({ id: COLUNA_BASE, pipeline_id: DEFAULT_PIPELINE_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'wa-own-1',
      nome: OWN_INSTANCE_NAME,
      owner_user_id: operador.id,
    });
  }

  const whereDoStageFindFirst = (prisma: any, i = 0) => prisma.stage.findFirst.mock.calls[i][0].where;

  it('toggle ON: a primeira etapa e procurada so entre as colunas BASE', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comPipelineDefault(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.create({ nome: 'Novo', telefone: '+5531900000001', temperatura: 'FRIO' }, operador);

    expect(whereDoStageFindFirst(prisma)).toEqual({
      pipeline_id: DEFAULT_PIPELINE_ID,
      tenant_id: 't1',
      user_id: null,
    });
  });

  it('toggle ON + pipeline_id explicito sem etapa: mesmo filtro de base', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comPipelineDefault(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.create(
      { nome: 'Novo', telefone: '+5531900000002', pipeline_id: NON_DEFAULT_PIPELINE_ID, temperatura: 'FRIO' },
      operador,
    );

    expect(whereDoStageFindFirst(prisma)).toEqual({
      pipeline_id: NON_DEFAULT_PIPELINE_ID,
      tenant_id: 't1',
      user_id: null,
    });
  });

  it('toggle OFF: o filtro de etapa fica exatamente o de antes da feature', async () => {
    const { service, prisma } = makeService();
    comPipelineDefault(prisma);

    await service.create({ nome: 'Novo', telefone: '+5531900000003', temperatura: 'FRIO' }, operador);

    expect(whereDoStageFindFirst(prisma)).toEqual({
      pipeline_id: DEFAULT_PIPELINE_ID,
      tenant_id: 't1',
    });
  });

  it('toggle ON: lead que nasce com dono e gravado na COLUNA DO DONO', async () => {
    const { service, prisma, gateway, kanbanIndividual } = makeService();
    comPipelineDefault(prisma);
    kanbanIndividual.isOn.mockResolvedValue(true);
    kanbanIndividual.stageForOwner.mockResolvedValue(COLUNA_DO_DONO);

    await service.create({ nome: 'Novo', telefone: '+5531900000004', temperatura: 'FRIO' }, operador);

    expect(kanbanIndividual.stageForOwner).toHaveBeenCalledWith('t1', operador.id, COLUNA_BASE);
    const payload = prisma.lead.create.mock.calls[0][0].data;
    expect(payload.estagio_id).toBe(COLUNA_DO_DONO);
    expect(payload.responsavel_id).toBe(operador.id);
    // A posicao (topo da coluna) tem que sair da coluna NOVA: tirada da base, o
    // card nasceria num ponto arbitrario do board do dono.
    expect(prisma.lead.aggregate.mock.calls[0][0].where.estagio_id).toBe(COLUNA_DO_DONO);
    // Regra global: mutacao de Kanban emite — com a coluna onde o card esta.
    expect(gateway.emitLeadCreated).toHaveBeenCalledWith(
      expect.any(String),
      { pipeline_id: DEFAULT_PIPELINE_ID, estagio_id: COLUNA_DO_DONO },
      't1',
    );
  });

  it('toggle ON + modo pool (lead nasce SEM dono): fica na base, sem traducao', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comPipelineDefault(prisma, true);
    kanbanIndividual.isOn.mockResolvedValue(true);

    await service.create({ nome: 'Novo', telefone: '+5531900000005', temperatura: 'FRIO' }, operador);

    expect(kanbanIndividual.stageForOwner).not.toHaveBeenCalled();
    expect(prisma.lead.create.mock.calls[0][0].data.estagio_id).toBe(COLUNA_BASE);
  });

  it('toggle OFF: nenhuma traducao de coluna, mesmo com dono', async () => {
    const { service, prisma, kanbanIndividual } = makeService();
    comPipelineDefault(prisma);

    await service.create({ nome: 'Novo', telefone: '+5531900000006', temperatura: 'FRIO' }, operador);

    expect(kanbanIndividual.stageForOwner).not.toHaveBeenCalled();
    expect(prisma.lead.create.mock.calls[0][0].data.estagio_id).toBe(COLUNA_BASE);
  });
});
