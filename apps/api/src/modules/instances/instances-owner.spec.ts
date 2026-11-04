import { BadRequestException, NotFoundException } from '@nestjs/common';
import { InstancesService } from './instances.service';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Responsável pelo número (Ferbraço): o gestor conecta o WhatsApp de cada
 * vendedor e ficava dono de todos — todo lead novo caía nele. `setOwner` troca
 * o `owner_user_id` (que o inbound usa para auto-atribuir) e, opcionalmente,
 * leva os leads que o número já recebeu.
 */

const TENANT = 'tenant-1';
const thiago: AuthUser = { id: 'thiago', nome: 'Thiago', email: 't@x.com', role: 'SUPER_ADMIN', ativo: true, tenantId: TENANT };

function montar(opts: { novo?: Record<string, unknown> | null; leads?: Array<Record<string, unknown>>; fullAccess?: boolean } = {}) {
  const prisma = {
    tenant: { findFirst: jest.fn().mockResolvedValue({ pool_enabled: false, manager_full_access: opts.fullAccess ?? false }) },
    instanceHidden: { findMany: jest.fn().mockResolvedValue([]) },
    whatsappInstance: {
      findFirst: jest.fn().mockResolvedValue({ id: 'inst-1', nome: 'yago', owner_user_id: 'thiago' }),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
    user: {
      findFirst: jest.fn().mockResolvedValue(opts.novo === undefined ? { id: 'yago', nome: 'Yago', role: 'OPERADOR' } : opts.novo),
    },
    lead: {
      findMany: jest.fn().mockResolvedValue(opts.leads ?? []),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    message: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    leadActivity: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation((fn: (tx: unknown) => unknown) => fn(prisma));
  const kanban = { stageForOwner: jest.fn(async (_t: string, _o: string, etapa: string) => `${etapa}-yago`) };
  const cache = { delPattern: jest.fn() };
  const gateway = { emitPipelineStagesChanged: jest.fn() };
  const service = new InstancesService(
    {} as never, { get: () => '' } as never, prisma as never, {} as never,
    kanban as never, cache as never, gateway as never,
  );
  return { service, prisma, kanban, gateway };
}

describe('InstancesService.setOwner', () => {
  it('sem transferir: troca o dono e liga o direcionamento, preservando o config do provedor', async () => {
    const { service, prisma } = montar();
    prisma.whatsappInstance.findFirst.mockResolvedValue({
      id: 'inst-1', nome: 'yago', owner_user_id: 'thiago', config: { provider: 'evolution' },
    });

    const res = await service.setOwner('inst-1', 'yago', false, thiago);

    expect(prisma.whatsappInstance.update).toHaveBeenCalledWith({
      where: { id: 'inst-1' },
      data: { owner_user_id: 'yago', config: { provider: 'evolution', direct_to_owner: true } },
    });
    expect(prisma.lead.findMany).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
    expect(res.leads_transferidos).toBe(0);
  });

  it('mesmo dono: liga a regra e puxa só os leads SEM dono do número', async () => {
    const { service, prisma } = montar({ leads: [{ id: 'l1', estagio_id: 'novo', pipeline_id: 'p1', responsavel_id: null }] });
    prisma.whatsappInstance.findFirst.mockResolvedValue({ id: 'inst-1', nome: 'yago', owner_user_id: 'yago', config: null });

    const res = await service.setOwner('inst-1', 'yago', true, thiago);

    expect(prisma.lead.findMany.mock.calls[0][0].where).toEqual({
      tenant_id: TENANT, instancia_whatsapp: 'yago', OR: [{ responsavel_id: null }],
    });
    expect(prisma.lead.updateMany.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ responsavel_id: 'yago', returned_at: null }),
    );
    expect(prisma.message.updateMany).not.toHaveBeenCalled();
    expect(res.leads_transferidos).toBe(1);
  });

  it('transferindo: leva os leads do número sem dono ou com o dono anterior, na coluna do novo dono', async () => {
    const { service, prisma, gateway } = montar({
      leads: [
        { id: 'l1', estagio_id: 'novo', pipeline_id: 'p1' },
        { id: 'l2', estagio_id: 'novo', pipeline_id: 'p1' },
      ],
    });

    const res = await service.setOwner('inst-1', 'yago', true, thiago);

    const donos = [{ responsavel_id: null }, { responsavel_id: 'thiago' }];
    const filtro = { tenant_id: TENANT, instancia_whatsapp: 'yago', OR: donos };
    expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: filtro }));
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { ...filtro, estagio_id: 'novo' },
      data: expect.objectContaining({ responsavel_id: 'yago', estagio_id: 'novo-yago' }),
    });
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, instancia_whatsapp: 'yago', OR: donos },
      data: { responsavel_id: 'yago' },
    });
    expect(prisma.message.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, instance_name: 'yago', visible_to_user_id: 'thiago' },
      data: { visible_to_user_id: 'yago' },
    });
    expect(prisma.leadActivity.createMany.mock.calls[0][0].data).toHaveLength(2);
    expect(gateway.emitPipelineStagesChanged).toHaveBeenCalledWith(TENANT, 'p1', 'yago');
    expect(res.leads_transferidos).toBe(2);
  });

  it('usuário de outro tenant, inativo ou VISUALIZADOR é recusado', async () => {
    await expect(montar({ novo: null }).service.setOwner('inst-1', 'x', false, thiago)).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      montar({ novo: { id: 'v', nome: 'V', role: 'VISUALIZADOR' } }).service.setOwner('inst-1', 'v', false, thiago),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('instância de outro tenant é 404', async () => {
    const { service, prisma } = montar();
    prisma.whatsappInstance.findFirst.mockResolvedValue(null);
    await expect(service.setOwner('inst-x', 'yago', false, thiago)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('InstancesService.findAll — gestor com acesso total', () => {
  it('modo Individual + manager_full_access: gestor vê todos os números', async () => {
    const { service, prisma } = montar({ fullAccess: true });
    await service.findAll(thiago);
    expect(prisma.whatsappInstance.findMany.mock.calls[0][0].where).toEqual({ tenant_id: TENANT });
  });

  it('sem a flag, ou para operador, segue vendo só os próprios', async () => {
    const semFlag = montar({ fullAccess: false });
    await semFlag.service.findAll(thiago);
    expect(semFlag.prisma.whatsappInstance.findMany.mock.calls[0][0].where).toEqual({ tenant_id: TENANT, owner_user_id: 'thiago' });

    const operador = montar({ fullAccess: true });
    await operador.service.findAll({ ...thiago, id: 'yago', role: 'OPERADOR' });
    expect(operador.prisma.whatsappInstance.findMany.mock.calls[0][0].where).toEqual({ tenant_id: TENANT, owner_user_id: 'yago' });
  });
});
