import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PlSalesService } from './pl-sales.service';
import { PL_TENANT, PL_PIPELINE } from './pl-sales.domain';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { AuthUser } from '../../common/types/auth-user';
const seller='b18d6d35-9321-4e6f-a754-2c7db3158ad2';
const id='ad4116c5-9f4f-4bf1-9591-2fc51aa20b93';
const manager:AuthUser={id:seller,nome:'Gestora',email:'test@example.invalid',role:'SUPER_ADMIN',ativo:true,tenantId:PL_TENANT};
const operator:AuthUser={...manager,role:'OPERADOR'};
const input={lead_id:id,seller_id:seller,contract_number:'pl-1',amount:'1234.56',sold_on:'2026-01-02',note:''};
function setup(){
 const emit=jest.fn();
 const tx={lead:{findFirst:jest.fn().mockResolvedValue({nome:'Cliente',telefone:'5537999999999'})},user:{findFirst:jest.fn().mockResolvedValue({nome:'Vendedora'}),findUniqueOrThrow:jest.fn().mockResolvedValue({nome:'Gestora'})},pLSale:{create:jest.fn().mockResolvedValue({id}),findFirst:jest.fn().mockResolvedValue({id,status:'ACTIVE',version:1}),updateMany:jest.fn().mockResolvedValue({count:1}),findUniqueOrThrow:jest.fn().mockResolvedValue({id,version:2})},pLMonthlyGoal:{findUnique:jest.fn().mockResolvedValue(null),create:jest.fn().mockResolvedValue({id,version:1}),update:jest.fn().mockResolvedValue({id,version:2})},pLSalesAudit:{create:jest.fn().mockResolvedValue({id})}};
 const prisma={...tx,$transaction:jest.fn(async(work:(t:typeof tx)=>Promise<unknown>)=>work(tx))};
 const service=new PlSalesService(prisma as unknown as PrismaService,{server:{to:()=>({emit})}} as unknown as CrmGateway);
 return {service,tx,prisma,emit};
}
describe('PL sales access, transactions and corrections',()=>{
 it('rejects other tenants and viewers before database access',async()=>{const m=setup();await expect(m.service.create({...manager,tenantId:'other'},input)).rejects.toBeInstanceOf(ForbiddenException);await expect(m.service.create({...manager,role:'VISUALIZADOR'},input)).rejects.toBeInstanceOf(ForbiddenException);expect(m.prisma.$transaction).not.toHaveBeenCalled();});
 it('creates and audits within same transaction after checking PL lead and seller',async()=>{const m=setup();await m.service.create(operator,input);expect(m.tx.lead.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({tenant_id:PL_TENANT,pipeline_id:PL_PIPELINE,responsavel_id:seller})}));expect(m.tx.pLSale.create).toHaveBeenCalledWith({data:expect.objectContaining({contract_number:'PL-1',amount:'1234.56',customer_name:'Cliente',seller_name:'Vendedora'})});expect(m.tx.pLSalesAudit.create).toHaveBeenCalled();expect(m.emit).toHaveBeenCalledTimes(1);});
 it('blocks operator selling for somebody else or modifying goals',async()=>{const m=setup();await expect(m.service.create(operator,{...input,seller_id:id})).rejects.toBeInstanceOf(ForbiddenException);await expect(m.service.goal(operator,'2026-10','team',{amount:'100',expectedVersion:0})).rejects.toBeInstanceOf(ForbiddenException);expect(m.tx.pLSale.create).not.toHaveBeenCalled();});
 it('rejects inaccessible/partner leads and administrative sellers',async()=>{const m=setup();m.tx.lead.findFirst.mockResolvedValue(null);await expect(m.service.create(manager,input)).rejects.toBeInstanceOf(BadRequestException);m.tx.lead.findFirst.mockResolvedValue({nome:'Cliente',telefone:'5537999999999'});m.tx.user.findFirst.mockResolvedValue(null);await expect(m.service.create(manager,input)).rejects.toBeInstanceOf(BadRequestException);expect(m.tx.pLSale.create).not.toHaveBeenCalled();expect(m.tx.user.findFirst).toHaveBeenCalledWith(expect.objectContaining({where:expect.objectContaining({OR:[{sector_id:null},{sector:{name:{not:'Administrativo',mode:'insensitive'}}}]})}));});
 it('rejects future dates and zero values',async()=>{const m=setup();await expect(m.service.create(manager,{...input,sold_on:'2100-01-01'})).rejects.toBeInstanceOf(BadRequestException);await expect(m.service.create(manager,{...input,amount:'0.00'})).rejects.toThrow();expect(m.tx.pLSale.create).not.toHaveBeenCalled();});
 it('maps duplicate contract to conflict and does not broadcast success',async()=>{const m=setup();m.tx.pLSale.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('duplicate',{code:'P2002',clientVersion:'5.22'}));await expect(m.service.create(manager,input)).rejects.toBeInstanceOf(ConflictException);expect(m.emit).not.toHaveBeenCalled();});
 it('rejects stale edits without audit',async()=>{const m=setup();m.tx.pLSale.updateMany.mockResolvedValue({count:0});await expect(m.service.update(manager,id,{...input,expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);expect(m.tx.pLSalesAudit.create).not.toHaveBeenCalled();expect(m.emit).not.toHaveBeenCalled();});
 it('cancels without deleting and audits reason',async()=>{const m=setup();await m.service.cancel(manager,id,{expectedVersion:1,reason:'Cliente desistiu'});expect(m.tx.pLSale.updateMany).toHaveBeenCalledWith({where:{id,tenant_id:PL_TENANT,version:1,status:'ACTIVE'},data:expect.objectContaining({status:'CANCELLED'})});expect(m.tx.pLSalesAudit.create).toHaveBeenCalledWith({data:expect.objectContaining({action:'sale.cancelled',after:{status:'CANCELLED',reason:'Cliente desistiu'}})});});
 it('preserves changed goal when submitted version is stale',async()=>{const m=setup();m.tx.pLMonthlyGoal.findUnique.mockResolvedValue({id,version:2});await expect(m.service.goal(manager,'2026-10','team',{amount:'1000.00',expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);expect(m.tx.pLMonthlyGoal.update).not.toHaveBeenCalled();});
});

it('keeps original seller snapshots when correcting a historic sale after seller deactivation', async()=>{
 const m=setup();m.tx.pLSale.findFirst.mockResolvedValue({id,status:'ACTIVE',version:1,lead_id:input.lead_id,customer_name:'Nome original',customer_phone:'5537999999999',seller_id:seller,seller_name:'Vendedora original'});
 m.tx.user.findFirst.mockResolvedValue(null);
 await m.service.update(manager,id,{...input,amount:'2000.00',expectedVersion:1});
 expect(m.tx.user.findFirst).not.toHaveBeenCalled();
 expect(m.tx.pLSale.updateMany).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({seller_name:'Vendedora original',customer_name:'Nome original',amount:'2000.00'})}));
});
