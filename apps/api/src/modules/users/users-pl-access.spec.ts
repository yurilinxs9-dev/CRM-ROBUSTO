import { ForbiddenException } from '@nestjs/common';
import { UsersService } from './users.service';
import type { AuthUser } from '../../common/types/auth-user';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { MediaService } from '../media/media.service';
import type { SectorsService } from '../sectors/sectors.service';
import type { KanbanIndividualService } from '../pipelines/kanban-individual.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { RedisCacheService } from '../../common/cache/redis-cache.service';

const tenantId = 'a44772ed-1382-4400-84fc-3fa350e23e42';
const manager: AuthUser = { id: 'manager', tenantId, role: 'GERENTE', nome: 'Gestora', email: 'manager@example.test', ativo: true };
const target = { id: 'seller', role: 'OPERADOR', tenant_id: tenantId, pl_sales_only: false };
function setup() {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(target), update: jest.fn().mockImplementation(({data}) => Promise.resolve({...target,...data})), findMany: jest.fn().mockResolvedValue([]) } };
  const cache = { del: jest.fn().mockResolvedValue(undefined) };
  const gateway = { disconnectUser: jest.fn() };
  const service = new UsersService(prisma as unknown as PrismaService, {} as MediaService, {} as SectorsService, { isOn: jest.fn().mockResolvedValue(false) } as unknown as KanbanIndividualService, cache as unknown as RedisCacheService, gateway as unknown as CrmGateway);
  return {service,prisma,cache,gateway};
}
describe('PL restricted salesperson configuration', () => {
  it('persists an explicit operator opt-in without changing role or sector', async () => {
    const {service,prisma,cache,gateway}=setup();
    await service.updateTeamMember(manager,'seller',{pl_sales_only:true});
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({data:{pl_sales_only:true}}));
    expect(cache.del).toHaveBeenCalledWith('auth:user:seller');
    expect(gateway.disconnectUser).toHaveBeenCalledWith('seller');
  });
  it('preserves the flag unless explicitly changed', async () => {
    const { service, prisma, gateway } = setup();
    await service.updateTeamMember(manager, 'seller', { titulo: 'Comercial' });
    expect(prisma.user.update).toHaveBeenCalledWith(expect.objectContaining({ data: { titulo: 'Comercial' } }));
    expect(gateway.disconnectUser).not.toHaveBeenCalled();
  });
  it('requires deactivating restricted profile before promoting role', async () => {
    const { service, prisma } = setup();
    prisma.user.findUnique.mockResolvedValue({ ...target, pl_sales_only: true });
    await expect(service.updateTeamMember(manager, 'seller', { role: 'GERENTE' })).rejects.toThrow();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it.each([
    {...manager,tenantId:'other'}, {...manager,id:'seller',role:'OPERADOR' as const},
  ])('rejects unauthorized profile configuration', async caller => {
    const {service,prisma}=setup();
    if(caller.tenantId==='other') prisma.user.findUnique.mockResolvedValue({...target,tenant_id:'other'});
    await expect(service.updateTeamMember(caller,'seller',{pl_sales_only:true})).rejects.toThrow(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it('does not let a manager carry the restricted salesperson flag', async () => {
    const {service,prisma}=setup();prisma.user.findUnique.mockResolvedValue({...target,role:'GERENTE'});
    await expect(service.updateTeamMember(manager,'seller',{pl_sales_only:true})).rejects.toThrow();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
  it('returns only self in the collaborator selector for a restricted salesperson', async () => {
    const {service,prisma}=setup();await service.findAllForTenant({...manager,id:'seller',role:'OPERADOR',plSalesOnly:true});
    expect(prisma.user.findMany).toHaveBeenCalledWith(expect.objectContaining({where:{tenant_id:tenantId,ativo:true,id:'seller'}}));
  });
});
