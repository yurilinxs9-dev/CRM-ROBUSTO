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
      aggregate: jest.fn().mockResolvedValue({ _max: { position: null } }),
      create: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'lead-new-1', ...data }),
      ),
    },
    leadActivity: { create: jest.fn().mockResolvedValue({}) },
    // create() usa $transaction em modo ARRAY: [this.prisma.lead.create(...)].
    // As promises ja foram construidas antes de chegar aqui — só precisamos
    // resolve-las e devolver o array de resultados.
    $transaction: jest.fn((arg: unknown) => Promise.all(arg as Promise<unknown>[])),
  };
  const cache: any = { delPattern: jest.fn() };
  const gateway: any = { emitLeadUpdated: jest.fn() };
  const outboundWebhooks: any = {
    dispatchLeadEvent: jest.fn().mockReturnValue(Promise.resolve()),
  };
  return { prisma, cache, gateway, outboundWebhooks };
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

  it('modo Individual sem instancia conectada para o usuario: rejeita com BadRequestException', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID });
    prisma.whatsappInstance.findFirst.mockResolvedValue(null);

    await expect(
      service.create(
        { nome: 'Novo Contato', telefone: '+5531999999999', estagio_id: ESTAGIO_ID },
        operador,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
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
