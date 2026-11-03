import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { UsersService } from './users.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Gestao da equipe pelo admin do tenant: editar credenciais e excluir membro.
 *
 * Regras que esta suite trava:
 *  - email/senha e exclusao so de quem esta ABAIXO do gestor (GERENTE nao mexe
 *    em GERENTE; ninguem mexe em SUPER_ADMIN, platform admin ou em si mesmo);
 *  - membro de outro tenant e 404, nunca escrita cross-tenant;
 *  - excluir devolve os leads ao escritorio, desmonta o board pessoal e passa
 *    as tarefas para quem excluiu — tudo na mesma transacao;
 *  - FK inesperada (drift do banco) vira 409 com o caminho "desative".
 */

const TENANT = 'tenant-1';

const admin: AuthUser = {
  id: 'adm',
  nome: 'Admin',
  email: 'adm@x.com',
  role: UserRole.SUPER_ADMIN as unknown as AuthUser['role'],
  ativo: true,
  tenantId: TENANT,
};
const gerente: AuthUser = { ...admin, id: 'g1', email: 'g@x.com', role: UserRole.GERENTE as unknown as AuthUser['role'] };

const contagemVazia = {
  owned_tenants: 0,
  owned_instances: 0,
  sales_partners: 0,
  partner_productions: 0,
  partner_goals: 0,
  partner_audits: 0,
};

function montar(alvo: Record<string, unknown> | null) {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(where.id ? alvo : null),
      ),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'alvo', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    stage: { findMany: jest.fn().mockResolvedValue([{ pipeline_id: 'p1' }]), count: jest.fn().mockResolvedValue(1) },
    lead: { findMany: jest.fn().mockResolvedValue([{ pipeline_id: 'p2' }]), updateMany: jest.fn().mockResolvedValue({ count: 3 }) },
    conversation: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    message: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    leadActivity: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    quickReply: { deleteMany: jest.fn().mockResolvedValue({ count: 0 }), updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    task: { updateMany: jest.fn().mockResolvedValue({ count: 2 }) },
    refreshToken: { deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((fn: (tx: unknown) => unknown) => fn(prisma)),
  };
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(false),
    removePersonalBoard: jest.fn().mockResolvedValue(4),
  };
  const cache: any = { del: jest.fn(), delPattern: jest.fn() };
  const gateway: any = { disconnectUser: jest.fn(), emitPipelineStagesChanged: jest.fn() };
  const service = new UsersService(prisma, {} as any, { assertActiveForTenant: jest.fn() } as any, kanbanIndividual, cache, gateway);
  return { service, prisma, kanbanIndividual, gateway };
}

const operador = { id: 'alvo', nome: 'Op', email: 'op@x.com', role: 'OPERADOR', tenant_id: TENANT, is_platform_admin: false, pl_sales_only: false, _count: contagemVazia };

describe('UsersService.deleteTeamMember', () => {
  it('devolve leads, solta conversas, desmonta o board e passa tarefas para quem excluiu', async () => {
    const { service, prisma, kanbanIndividual, gateway } = montar(operador);

    await expect(service.deleteTeamMember(gerente, 'alvo')).resolves.toEqual({ ok: true });

    expect(kanbanIndividual.removePersonalBoard).toHaveBeenCalledWith(prisma, TENANT, 'alvo');
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { tenant_id: TENANT, responsavel_id: 'alvo' },
      data: expect.objectContaining({ responsavel_id: null, assumed_at: null, is_private: false }),
    });
    expect(prisma.conversation.updateMany).toHaveBeenCalledWith(expect.objectContaining({ data: { responsavel_id: null, assumed_at: null } }));
    expect(prisma.task.updateMany).toHaveBeenCalledWith({ where: { responsavel_id: 'alvo' }, data: { responsavel_id: gerente.id } });
    expect(prisma.user.delete).toHaveBeenCalledWith({ where: { id: 'alvo' } });
    expect(gateway.disconnectUser).toHaveBeenCalledWith('alvo');
    expect(gateway.emitPipelineStagesChanged).toHaveBeenCalledTimes(2);
  });

  it('membro de outro tenant e 404', async () => {
    const { service, prisma } = montar({ ...operador, tenant_id: 'outro' });
    await expect(service.deleteTeamMember(gerente, 'alvo')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('GERENTE nao exclui outro GERENTE; SUPER_ADMIN pode', async () => {
    const alvoGerente = { ...operador, role: 'GERENTE' };
    await expect(montar(alvoGerente).service.deleteTeamMember(gerente, 'alvo')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(montar(alvoGerente).service.deleteTeamMember(admin, 'alvo')).resolves.toEqual({ ok: true });
  });

  it('nao exclui a si mesmo, SUPER_ADMIN nem platform admin', async () => {
    await expect(montar({ ...operador, id: gerente.id }).service.deleteTeamMember(gerente, gerente.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(montar({ ...operador, role: 'SUPER_ADMIN' }).service.deleteTeamMember(admin, 'alvo')).rejects.toBeInstanceOf(ForbiddenException);
    await expect(montar({ ...operador, is_platform_admin: true }).service.deleteTeamMember(admin, 'alvo')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('dono de instancia ou com historico de parceiros e barrado antes da transacao', async () => {
    const comInstancia = montar({ ...operador, _count: { ...contagemVazia, owned_instances: 1 } });
    await expect(comInstancia.service.deleteTeamMember(gerente, 'alvo')).rejects.toBeInstanceOf(ConflictException);
    expect(comInstancia.prisma.$transaction).not.toHaveBeenCalled();

    const comParceiros = montar({ ...operador, _count: { ...contagemVazia, partner_audits: 2 } });
    await expect(comParceiros.service.deleteTeamMember(gerente, 'alvo')).rejects.toBeInstanceOf(ConflictException);
  });

  it('FK inesperada vira 409 com orientacao de desativar', async () => {
    const { service, prisma } = montar(operador);
    prisma.user.delete.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('fk', { code: 'P2003', clientVersion: 'test' }),
    );
    await expect(service.deleteTeamMember(gerente, 'alvo')).rejects.toThrow(/Desative/);
  });
});

describe('UsersService.updateTeamMember — credenciais', () => {
  it('troca a senha com bcrypt e derruba as sessoes do membro', async () => {
    const { service, prisma, gateway } = montar(operador);

    await service.updateTeamMember(gerente, 'alvo', { senha: 'nova-senha-123' });

    const data = prisma.user.update.mock.calls[0][0].data;
    expect(data.senha_hash).toMatch(/^\$2[aby]\$12\$/);
    expect(prisma.refreshToken.deleteMany).toHaveBeenCalledWith({ where: { user_id: 'alvo' } });
    expect(gateway.disconnectUser).toHaveBeenCalledWith('alvo');
  });

  it('email ja usado por outra conta e 409', async () => {
    const { service, prisma } = montar(operador);
    prisma.user.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.id ? operador : { id: 'outra' }),
    );
    await expect(service.updateTeamMember(gerente, 'alvo', { email: 'ocupado@x.com' })).rejects.toBeInstanceOf(ConflictException);
  });

  it('GERENTE nao troca senha de outro GERENTE, mas pode renomear', async () => {
    const alvoGerente = { ...operador, role: 'GERENTE' };
    await expect(montar(alvoGerente).service.updateTeamMember(gerente, 'alvo', { senha: 'nova-senha-123' })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(montar(alvoGerente).service.updateTeamMember(gerente, 'alvo', { nome: 'Novo Nome' })).resolves.toBeDefined();
  });
});
