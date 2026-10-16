import { InstancesService } from './instances.service';
import type { AuthUser } from '../../common/types/auth-user';
const user: AuthUser = { id: 'seller', tenantId: 'a44772ed-1382-4400-84fc-3fa350e23e42', role: 'OPERADOR', nome: 'Seller', email: 'seller@example.test', ativo: true, plSalesOnly: true };
it('consulta só números próprios e nunca retorna credenciais do provedor', async () => {
  const row = { id: 'instance', nome: 'personal', telefone: '5511000000000', status: 'connected', ultimo_check: null, config: { uazapi_token: 'private' }, webhook_secret: 'private' };
  const prisma = {
    tenant: { findFirst: jest.fn().mockResolvedValue({ pool_enabled: true }) },
    instanceHidden: { findMany: jest.fn().mockResolvedValue([]) },
    whatsappInstance: { findMany: jest.fn(async ({ select }: { select?: Record<string, boolean> }) => [select ? Object.fromEntries(Object.entries(row).filter(([key]) => select[key])) : row]) },
  };
  const service = new InstancesService({} as never, { get: () => '' } as never, prisma as never, {} as never);
  const result = await service.findAll(user);
  expect(prisma.whatsappInstance.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenant_id: user.tenantId, owner_user_id: user.id } }));
  expect(result[0]).toEqual({ id: row.id, nome: row.nome, telefone: row.telefone, status: row.status, ultimo_check: null });
  expect(await service.findAll({ ...user, plSalesOnly: false })).toEqual([row]);
});
