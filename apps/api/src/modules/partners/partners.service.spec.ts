import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { CrmGateway } from '../websocket/websocket.gateway';
import { PARTNER_TENANT_ID } from './partners.domain';
import { PartnersService } from './partners.service';
const id='11111111-1111-4111-8111-111111111111';
const user:AuthUser={id,nome:'Operator',email:'local@example.test',role:'OPERADOR',ativo:true,tenantId:PARTNER_TENANT_ID};
const partner={id,tenant_id:PARTNER_TENANT_ID,active:true,name:'Local partner',version:1};
const existing={id,tenant_id:PARTNER_TENANT_ID,partner_id:id,date:new Date('2026-01-01T00:00:00Z'),amount:new Prisma.Decimal('1'),note:null,version:1,updated_at:new Date('2026-01-01T00:00:00Z')};
function fixture() {
 const tx={partnerTeamActivity:{findFirst:jest.fn().mockResolvedValue(null)},salesPartner:{deleteMany:jest.fn().mockResolvedValue({count:1}),findMany:jest.fn(),findFirst:jest.fn().mockResolvedValue(partner),updateMany:jest.fn().mockResolvedValue({count:1}),create:jest.fn()},partnerDailyProduction:{findFirst:jest.fn().mockResolvedValue(null),findMany:jest.fn(),findUnique:jest.fn().mockResolvedValue(null),create:jest.fn().mockResolvedValue({...existing,amount:new Prisma.Decimal('12.34')}),updateMany:jest.fn().mockResolvedValue({count:1}),findUniqueOrThrow:jest.fn().mockResolvedValue({...existing,version:2})},partnerMonthlyGoal:{findUnique:jest.fn().mockResolvedValue(null),create:jest.fn(),updateMany:jest.fn(),findUniqueOrThrow:jest.fn()},partnerProductionAudit:{updateMany:jest.fn().mockResolvedValue({count:1}),create:jest.fn().mockResolvedValue({})},user:{findMany:jest.fn(),findFirst:jest.fn().mockResolvedValue(null)},lead:{findFirst:jest.fn().mockResolvedValue(null),findMany:jest.fn().mockResolvedValue([])}};
 const prisma={...tx,$transaction:jest.fn(async (fn: (value:typeof tx)=>Promise<unknown>)=>fn(tx))}; const emit=jest.fn(); const to=jest.fn().mockReturnValue({emit}); const service=new PartnersService(prisma as unknown as PrismaService,{server:{to}} as unknown as CrmGateway); return {service,tx,prisma,emit,to};
}
describe('partners service isolation and concurrency',()=>{
 it('rejects foreign workspace before accessing Prisma',async()=>{const f=fixture();await expect(f.service.dashboard({...user,tenantId:'other'},'2026-01')).rejects.toBeInstanceOf(ForbiddenException);expect(f.prisma.$transaction).not.toHaveBeenCalled();});
 it('rejects viewer mutations and operator administration',async()=>{const f=fixture();await expect(f.service.production({...user,role:'VISUALIZADOR'},id,'2026-01-01',{amount:'1',expectedVersion:0})).rejects.toBeInstanceOf(ForbiddenException);await expect(f.service.create(user,{})).rejects.toBeInstanceOf(ForbiddenException);await expect(f.service.goal(user,'2026-01',{amount:'1',expectedVersion:0})).rejects.toBeInstanceOf(ForbiddenException);});
 it('treats a foreign partner as missing',async()=>{const f=fixture();f.tx.salesPartner.findFirst.mockResolvedValue(null);await expect(f.service.production(user,id,'2026-01-01',{amount:'1',expectedVersion:0})).rejects.toBeInstanceOf(NotFoundException);expect(f.tx.salesPartner.findFirst).toHaveBeenCalledWith({where:{id,tenant_id:PARTNER_TENANT_ID}});});
 it('validates responsible member and lead within tenant',async()=>{const f=fixture();const manager={...user,role:'GERENTE' as const};const body={name:'Local',joined_on:'2026-01-01',owner_id:id};await expect(f.service.create(manager,body)).rejects.toThrow('Responsável');await expect(f.service.create(manager,{name:'Local',joined_on:'2026-01-01',lead_id:id})).rejects.toThrow('Lead');expect(f.tx.salesPartner.create).not.toHaveBeenCalled();});
 it('creates total and audit in same serializable transaction, emits only tenant room',async()=>{const f=fixture();const result=await f.service.production(user,id,'2026-01-01',{amount:'12.34',expectedVersion:0});expect(result.amount).toBe('12.34');expect(f.tx.partnerProductionAudit.create).toHaveBeenCalledWith(expect.objectContaining({data:expect.objectContaining({tenant_id:PARTNER_TENANT_ID,actor_id:id,action:'production.saved'})}));expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'Serializable'});expect(f.to).toHaveBeenCalledWith(`tenant:${PARTNER_TENANT_ID}`);expect(f.emit).toHaveBeenCalledWith('partners:updated',{});});
 it('rejects double creation and stale replacement',async()=>{const f=fixture();f.tx.partnerDailyProduction.findUnique.mockResolvedValue(existing);for(const expectedVersion of [0,2])await expect(f.service.production(user,id,'2026-01-01',{amount:'99',expectedVersion})).rejects.toBeInstanceOf(ConflictException);expect(f.tx.partnerDailyProduction.updateMany).not.toHaveBeenCalled();expect(f.emit).not.toHaveBeenCalled();});
 it('rejects concurrent compare-and-swap failure without audit',async()=>{const f=fixture();f.tx.partnerDailyProduction.findUnique.mockResolvedValue(existing);f.tx.partnerDailyProduction.updateMany.mockResolvedValue({count:0});await expect(f.service.production(user,id,'2026-01-01',{amount:'99',expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);expect(f.tx.partnerProductionAudit.create).not.toHaveBeenCalled();});
 it('maps database unique collision and serialization failure to 409',async()=>{for(const code of ['P2002','P2034']){const f=fixture();f.tx.partnerDailyProduction.create.mockRejectedValue(new Prisma.PrismaClientKnownRequestError('collision',{code,clientVersion:'5'}));await expect(f.service.production(user,id,'2026-01-01',{amount:'1',expectedVersion:0})).rejects.toBeInstanceOf(ConflictException);}});
 it('inactive cannot receive new total; historical correction requires manager',async()=>{const f=fixture();f.tx.salesPartner.findFirst.mockResolvedValue({...partner,active:false});await expect(f.service.production(user,id,'2026-01-01',{amount:'1',expectedVersion:0})).rejects.toThrow('inativo');f.tx.partnerDailyProduction.findUnique.mockResolvedValue(existing);await expect(f.service.production(user,id,'2026-01-01',{amount:'0',expectedVersion:1})).rejects.toBeInstanceOf(ForbiddenException);await expect(f.service.production({...user,role:'GERENTE'},id,'2026-01-01',{amount:'0',expectedVersion:1})).resolves.toHaveProperty('version',2);});
 it('does not emit when audit fails; transaction propagates error',async()=>{const f=fixture();f.tx.partnerProductionAudit.create.mockRejectedValue(new Error('audit unavailable'));await expect(f.service.production(user,id,'2026-01-01',{amount:'1',expectedVersion:0})).rejects.toThrow('audit unavailable');expect(f.emit).not.toHaveBeenCalled();});
 it('rejects future dates and tenant supplied in input',async()=>{const f=fixture();await expect(f.service.production(user,id,'2099-01-01',{amount:'1',expectedVersion:0})).rejects.toThrow('futuras');await expect(f.service.production(user,id,'2026-01-01',{amount:'1',expectedVersion:0,tenant_id:'other'})).rejects.toThrow('Unrecognized');});
});

describe('partners dashboard',()=>{
 it('sums exact cents, keeps archived history and ranks only positive totals',async()=>{
  const f=fixture();const second='22222222-2222-4222-8222-222222222222';const empty='33333333-3333-4333-8333-333333333333';
  const base={...partner,contact:null,phone:null,notes:null,joined_on:new Date('2025-01-01'),owner_id:null,lead_id:null,owner:null};
  f.prisma.$transaction.mockResolvedValueOnce([
   [{...base,active:false},{...base,id:second,name:'Active'},{...base,id:empty,name:'Zero'}],
   [{...existing,amount:new Prisma.Decimal('0.10'),actor:{nome:'Local'}},{...existing,id:second,amount:new Prisma.Decimal('0.20'),actor:{nome:'Local'}},{...existing,id:empty,partner_id:second,amount:new Prisma.Decimal('1.01'),actor:{nome:'Local'}},{...existing,id:'zero',partner_id:empty,amount:new Prisma.Decimal('0'),actor:{nome:'Local'}}],
   null,[]
  ]);
  const result=await f.service.dashboard(user,'2026-01');expect(result.summary.total).toBe('1.31');expect(result.summary.target).toBeNull();expect(result.summary.required_per_day).toBeNull();expect(result.ranking.map(p=>p.id)).toEqual([second,id]);expect(result.partners[0].monthly_total).toBe('0.30');expect(result.summary.active_partners).toBe(2);expect(result.summary.producing_partners).toBe(2);expect(result.daily[0].accumulated).toBe('1.31');expect(result.daily).toHaveLength(31);
 });
 it('rejects stale goal and partner version and never audits them',async()=>{const f=fixture();f.tx.partnerMonthlyGoal.findUnique.mockResolvedValue({...existing,month:'2026-01'});await expect(f.service.goal({...user,role:'GERENTE'},'2026-01',{amount:'99',expectedVersion:0})).rejects.toBeInstanceOf(ConflictException);f.tx.salesPartner.updateMany.mockResolvedValue({count:0});await expect(f.service.update({...user,role:'GERENTE'},id,{name:'Changed',expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);expect(f.tx.partnerProductionAudit.create).not.toHaveBeenCalled();});
});


describe('partner deletion',()=>{
 const manager:AuthUser={...user,role:'SUPER_ADMIN'};
 it('deletes an empty partner and preserves audit snapshots in one transaction',async()=>{
  const f=fixture();await expect(f.service.remove(manager,id,{expectedVersion:1})).resolves.toEqual({id,deleted:true});
  expect(f.tx.partnerDailyProduction.findFirst).toHaveBeenCalledWith({where:{tenant_id:PARTNER_TENANT_ID,partner_id:id},select:{id:true}});
  expect(f.tx.partnerProductionAudit.updateMany).toHaveBeenCalledWith({where:{tenant_id:PARTNER_TENANT_ID,partner_id:id},data:{partner_id:null}});
  expect(f.tx.salesPartner.deleteMany).toHaveBeenCalledWith({where:{id,tenant_id:PARTNER_TENANT_ID,version:1}});
  expect(f.tx.partnerProductionAudit.create).toHaveBeenCalledWith({data:expect.objectContaining({action:'partner.deleted',partner_id:null,entity_id:id,before:partner,after:{deleted:true,name:partner.name}})});
  expect(f.prisma.$transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'Serializable'});
  expect(f.emit).toHaveBeenCalledWith('partners:updated',{});
 });
 it('blocks any sales entry, including zero amounts and old months',async()=>{
  const f=fixture();f.tx.partnerDailyProduction.findFirst.mockResolvedValue({id});
  await expect(f.service.remove(manager,id,{expectedVersion:1})).rejects.toThrow('lançamentos');
  expect(f.tx.salesPartner.deleteMany).not.toHaveBeenCalled();expect(f.tx.partnerProductionAudit.updateMany).not.toHaveBeenCalled();
 });
 it('blocks non-managers and foreign workspaces before touching the database',async()=>{
  const f=fixture();for(const caller of [user,{...manager,tenantId:'other'},{...user,role:'VISUALIZADOR' as const}]) await expect(f.service.remove(caller,id,{expectedVersion:1})).rejects.toBeInstanceOf(ForbiddenException);
  expect(f.prisma.$transaction).not.toHaveBeenCalled();
 });
 it('does not delete missing or stale partners',async()=>{
  const f=fixture();await expect(f.service.remove(manager,id,{expectedVersion:2})).rejects.toBeInstanceOf(ConflictException);
  f.tx.salesPartner.findFirst.mockResolvedValue(null);await expect(f.service.remove(manager,id,{expectedVersion:1})).rejects.toBeInstanceOf(NotFoundException);
  expect(f.tx.salesPartner.deleteMany).not.toHaveBeenCalled();
 });
 it('rejects concurrent edits and foreign-key races',async()=>{
  const f=fixture();f.tx.salesPartner.deleteMany.mockResolvedValueOnce({count:0});await expect(f.service.remove(manager,id,{expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);
  f.tx.salesPartner.deleteMany.mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('linked record',{code:'P2003',clientVersion:'5'}));await expect(f.service.remove(manager,id,{expectedVersion:1})).rejects.toBeInstanceOf(ConflictException);
  expect(f.emit).not.toHaveBeenCalled();expect(f.tx.partnerProductionAudit.create).not.toHaveBeenCalled();
 });
 it('propagates audit failure so the deletion transaction rolls back without notification',async()=>{
  const f=fixture();f.tx.partnerProductionAudit.create.mockRejectedValueOnce(new Error('audit unavailable'));
  await expect(f.service.remove(manager,id,{expectedVersion:1})).rejects.toThrow('audit unavailable');expect(f.emit).not.toHaveBeenCalled();
 });
});
