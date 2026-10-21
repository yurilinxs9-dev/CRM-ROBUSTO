import { ForbiddenException } from '@nestjs/common';
import { TenantsService } from './tenants.service';

function makeService() {
  const prisma = { tenant: { update: jest.fn().mockResolvedValue({}) } };
  return { svc: new TenantsService(prisma as never), prisma };
}

describe('TenantsService.updateSettings — acesso total do gestor', () => {
  it('SUPER_ADMIN liga e desliga a opção', async () => {
    const { svc, prisma } = makeService();
    await svc.updateSettings({ tenantId: 'tenant-1', role: 'SUPER_ADMIN' } as never, { manager_full_access: true });
    await svc.updateSettings({ tenantId: 'tenant-1', role: 'SUPER_ADMIN' } as never, { manager_full_access: false });
    expect(prisma.tenant.update.mock.calls[0][0].data.manager_full_access).toBe(true);
    expect(prisma.tenant.update.mock.calls[1][0].data.manager_full_access).toBe(false);
  });

  it('GERENTE não altera a opção — abrir todas as conversas é decisão do dono da conta', async () => {
    const { svc, prisma } = makeService();
    await expect(
      svc.updateSettings({ tenantId: 'tenant-1', role: 'GERENTE' } as never, { manager_full_access: true }),
    ).rejects.toThrow(ForbiddenException);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('GERENTE segue alterando as demais opções', async () => {
    const { svc, prisma } = makeService();
    await svc.updateSettings({ tenantId: 'tenant-1', role: 'GERENTE' } as never, { share_history_enabled: true });
    expect(prisma.tenant.update.mock.calls[0][0].data).toEqual({ share_history_enabled: true });
  });
});
