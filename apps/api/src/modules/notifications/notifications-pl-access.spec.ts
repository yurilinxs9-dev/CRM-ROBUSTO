import { NotificationsService } from './notifications.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
const own = '369354c4-b4d6-4bb1-93c0-0afeedc1450e';
const other = 'b18d6d35-9321-4e6f-a754-2c7db3158ad2';
const user: AuthUser = { id: 'seller', tenantId: 'a44772ed-1382-4400-84fc-3fa350e23e42', role: 'OPERADOR', nome: 'Seller', email: 'seller@example.test', ativo: true, plSalesOnly: true };
it('oculta notificações antigas de leads fora da carteira e de áreas restritas', async () => {
  const rows = [{ id: 'own', link: `/chat/${own}` }, { id: 'old', link: `/chat/${other}` }, { id: 'partner', link: '/partners' }];
  const prisma = { notification: { findMany: jest.fn().mockResolvedValue(rows) }, lead: { findMany: jest.fn().mockResolvedValue([{ id: own }]) } };
  const service = new NotificationsService(prisma as unknown as PrismaService);
  expect(await service.findAll(user)).toEqual([rows[0]]);
  expect(prisma.lead.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ tenant_id: user.tenantId, responsavel_id: user.id }) }));
  expect(await service.findAll({ ...user, plSalesOnly: false })).toEqual(rows);
});
