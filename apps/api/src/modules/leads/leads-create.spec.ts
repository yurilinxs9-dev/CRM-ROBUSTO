import { BadRequestException } from '@nestjs/common';
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
 * compartilhado). estagio_id continua obrigatorio, mas agora e validado
 * contra o pipeline resolvido.
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

describe('LeadsService.create — deriva pipeline_id e instancia_whatsapp quando ausentes', () => {
  it('sem pipeline_id e sem instancia_whatsapp: usa pipeline default do tenant e a instancia propria do criador', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    prisma.stage.findFirst.mockResolvedValue({ id: ESTAGIO_ID });
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

  it('estagio_id que nao pertence ao pipeline resolvido e rejeitado', async () => {
    const { service, prisma } = makeService();
    prisma.tenant.findFirst.mockResolvedValue({ pool_enabled: false });
    prisma.pipeline.findFirst.mockResolvedValue({ id: DEFAULT_PIPELINE_ID, ativo: true });
    // Stage nao encontrado para este pipeline_id — simula estagio de outro pipeline.
    prisma.stage.findFirst.mockResolvedValue(null);

    await expect(
      service.create(
        { nome: 'Novo Contato', telefone: '+5531999999999', estagio_id: ESTAGIO_ID },
        operador,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.lead.create).not.toHaveBeenCalled();
  });
});
