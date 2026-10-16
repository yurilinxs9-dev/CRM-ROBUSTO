import { ForbiddenException } from '@nestjs/common';
import { TasksService } from './tasks.service';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { AuthUser } from '../../common/types/auth-user';

const user: AuthUser = { id: 'seller', tenantId: 'a44772ed-1382-4400-84fc-3fa350e23e42', role: 'OPERADOR', nome: 'Seller', email: 'seller@example.test', ativo: true, plSalesOnly: true };
function setup() {
  const prisma = { task: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn().mockResolvedValue(null), create: jest.fn() }, lead: { findFirst: jest.fn().mockResolvedValue(null) } };
  const service = new TasksService(prisma as unknown as PrismaService, {} as CrmGateway);
  return { prisma, service };
}
describe('tarefas da vendedora PL restrita', () => {
  it('agenda exclui tarefas de leads transferidos e ignora filtro de outro responsável', async () => {
    const { prisma, service } = setup();
    await service.findAll(user, { responsavel_id: 'other' });
    expect(prisma.task.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: {
      tenant_id: user.tenantId, responsavel_id: user.id,
      AND: [{ OR: [{ lead_id: null }, { lead: { responsavel_id: user.id } }] }],
    } }));
  });
  it('não cria tarefa vinculada a lead fora da carteira', async () => {
    const { prisma, service } = setup();
    await expect(service.create({ titulo: 'Teste', lead_id: '369354c4-b4d6-4bb1-93c0-0afeedc1450e', scheduled_at: new Date() }, user)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.task.create).not.toHaveBeenCalled();
  });
});
