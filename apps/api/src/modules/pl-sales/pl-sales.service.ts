import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { CrmGateway } from '../websocket/websocket.gateway';
import { businessToday, monthDates } from '../partners/partners.domain';
import { PL_TENANT, PL_PIPELINE, saleSchema, updateSaleSchema, cancelSchema, monthSchema, plGoalSchema, monthlySummary } from './pl-sales.domain';
const date=(v:string)=>new Date(`${v}T00:00:00Z`);
const json=(v:unknown):Prisma.InputJsonValue=>JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
const manager=(user:AuthUser)=>['GERENTE','SUPER_ADMIN'].includes(user.role);
const sellerWhere: Prisma.UserWhereInput={ativo:true,role:{in:['OPERADOR','GERENTE','SUPER_ADMIN']},OR:[{sector_id:null},{sector:{name:{not:'Administrativo',mode:'insensitive'}}}]};
@Injectable()
export class PlSalesService {
  constructor(private readonly prisma:PrismaService,private readonly gateway:CrmGateway) {}
  private authorize(user:AuthUser, management=false) {
    if(user.tenantId!==PL_TENANT || !['OPERADOR','GERENTE','SUPER_ADMIN'].includes(user.role) || (management&&!manager(user))) throw new ForbiddenException('Área restrita à equipe autorizada da PL');
  }
  private notify() { this.gateway.server?.to(`tenant:${PL_TENANT}`).emit('pl-sales:updated',{}); }
  private async transaction<T>(work:(tx:Prisma.TransactionClient)=>Promise<T>):Promise<T> {
    try { return await this.prisma.$transaction(work,{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,timeout:15000}); }
    catch(e) { if(e instanceof Prisma.PrismaClientKnownRequestError && ['P2002','P2034'].includes(e.code)) throw new ConflictException('Contrato já registrado ou dados alterados por outra pessoa. Atualize antes de tentar novamente.'); throw e; }
  }
  private async audit(tx:Prisma.TransactionClient,user:AuthUser,entity:string,action:string,before:unknown,after:unknown) {
    const actor=await tx.user.findUniqueOrThrow({where:{id:user.id},select:{nome:true}});
    await tx.pLSalesAudit.create({data:{tenant_id:user.tenantId,entity_id:entity,actor_id:user.id,actor_name:actor.nome,action,before:before===null?Prisma.DbNull:json(before),after:json(after)}});
  }
  async dashboard(user:AuthUser,monthInput:unknown,pageInput:unknown=1) {
    this.authorize(user);const month=monthSchema.parse(monthInput??businessToday().slice(0,7));const page=z.coerce.number().int().min(1).max(100000).parse(pageInput);const days=monthDates(month);
    const where:Prisma.PLSaleWhereInput={tenant_id:user.tenantId,sold_on:{gte:date(days[0]),lte:date(days[days.length-1])},...(!manager(user)?{seller_id:user.id}:{})};
    const totalsQuery = this.prisma.pLSale.groupBy({by:['seller_id','seller_name'],orderBy:{seller_id:'asc'},where:{...where,status:'ACTIVE'},_sum:{amount:true},_count:{_all:true}});
    const [sales,count,totals,goals,members]=await this.prisma.$transaction([
      this.prisma.pLSale.findMany({where,orderBy:[{sold_on:'desc'},{id:'asc'}],skip:(page-1)*50,take:50}),
      this.prisma.pLSale.count({where}),
      totalsQuery,
      this.prisma.pLMonthlyGoal.findMany({where:{tenant_id:user.tenantId,month,...(!manager(user)?{owner_key:user.id}:{})}}),
      this.prisma.user.findMany({where:{tenant_id:user.tenantId,...sellerWhere,...(!manager(user)?{id:user.id}:{})},select:{id:true,nome:true},orderBy:{nome:'asc'}}),
    ],{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
    const grouped=new Map<string,{seller_id:string;seller_name:string;amount:Prisma.Decimal;contracts:number}>();
    for(const r of totals){const row=grouped.get(r.seller_id)??{seller_id:r.seller_id,seller_name:r.seller_name,amount:new Prisma.Decimal(0),contracts:0};row.amount=row.amount.plus(r._sum.amount??0);row.contracts+=r._count._all;grouped.set(r.seller_id,row);}
    for(const g of goals.filter(g=>g.owner_key!=='team'))if(!grouped.has(g.owner_key))grouped.set(g.owner_key,{seller_id:g.owner_key,seller_name:g.owner_name,amount:new Prisma.Decimal(0),contracts:0});
    const ranking=[...grouped.values()].sort((a,b)=>b.amount.comparedTo(a.amount)).map(r=>{const target=goals.find(g=>g.owner_key===r.seller_id);return {...r,amount:r.amount.toFixed(2),target:target?.amount.toFixed(2)??null};});
    const goal=goals.find(g=>g.owner_key===(manager(user)?'team':user.id));const summary=monthlySummary(ranking.map(r=>({amount:r.amount,status:'ACTIVE'})),goal?.amount??null);summary.contracts=ranking.reduce((n,r)=>n+r.contracts,0);
    return {month,pipeline_id:PL_PIPELINE,manager:manager(user),page,total:count,hasMore:page*50<count,summary,ranking,goals:goals.map(g=>({...g,amount:g.amount.toFixed(2)})),members:members.map(m=>({id:m.id,name:m.nome})),sales:sales.map(s=>({...s,amount:s.amount.toFixed(2),sold_on:s.sold_on.toISOString().slice(0,10)}))};
  }
  async candidates(user:AuthUser,input:unknown) {
    this.authorize(user);const search=z.string().trim().max(150).parse(input??'');
    return this.prisma.lead.findMany({where:{tenant_id:user.tenantId,pipeline_id:PL_PIPELINE,...(!manager(user)?{responsavel_id:user.id}:{}),...(search?{OR:[{nome:{contains:search,mode:'insensitive' as const}},{telefone:{contains:search}}]}:{})},select:{id:true,nome:true,telefone:true,responsavel_id:true},orderBy:{ultima_interacao:'desc'},take:30});
  }
  private async references(tx:Prisma.TransactionClient,user:AuthUser,data:z.infer<typeof saleSchema>, previous?:{lead_id:string;customer_name:string;customer_phone:string;seller_id:string;seller_name:string}) {
    if(!manager(user)&&data.seller_id!==user.id) throw new ForbiddenException('Registre somente suas próprias vendas');
    const lead=previous?.lead_id===data.lead_id ? {nome:previous.customer_name,telefone:previous.customer_phone} : await tx.lead.findFirst({where:{id:data.lead_id,tenant_id:user.tenantId,pipeline_id:PL_PIPELINE,...(!manager(user)?{responsavel_id:user.id}:{})},select:{nome:true,telefone:true}});
    if(!lead) throw new BadRequestException('Selecione um lead acessível do funil Consórcio PL');
    const seller=previous?.seller_id===data.seller_id ? {nome:previous.seller_name} : await tx.user.findFirst({where:{id:data.seller_id,tenant_id:user.tenantId,...sellerWhere},select:{nome:true}});
    if(!seller) throw new BadRequestException('Selecione uma vendedora ativa da equipe comercial');
    if(data.sold_on>businessToday()) throw new BadRequestException('A data de fechamento não pode ser futura');
    return {customer_name:lead.nome,customer_phone:lead.telefone,seller_name:seller.nome};
  }
  async create(user:AuthUser,input:unknown) {
    this.authorize(user);const data=saleSchema.parse(input);
    const result=await this.transaction(async tx=>{const refs=await this.references(tx,user,data);const sale=await tx.pLSale.create({data:{...data,...refs,contract_number:data.contract_number.toUpperCase(),sold_on:date(data.sold_on),tenant_id:user.tenantId,created_by:user.id,updated_by:user.id}});await this.audit(tx,user,sale.id,'sale.created',null,sale);return {id:sale.id};});this.notify();return result;
  }
  async update(user:AuthUser,id:string,input:unknown) {
    this.authorize(user,true);z.string().uuid().parse(id);const {expectedVersion,...data}=updateSaleSchema.parse(input);
    const result=await this.transaction(async tx=>{const before=await tx.pLSale.findFirst({where:{id,tenant_id:user.tenantId}});if(!before)throw new NotFoundException('Venda não encontrada');if(before.status!=='ACTIVE')throw new BadRequestException('Venda cancelada não pode ser editada');const refs=await this.references(tx,user,data,before);const result=await tx.pLSale.updateMany({where:{id,tenant_id:user.tenantId,version:expectedVersion,status:'ACTIVE'},data:{...data,...refs,contract_number:data.contract_number.toUpperCase(),sold_on:date(data.sold_on),updated_by:user.id,version:{increment:1}}});if(result.count!==1)throw new ConflictException('Venda alterada. Atualize a página antes de salvar');const after=await tx.pLSale.findUniqueOrThrow({where:{id}});await this.audit(tx,user,id,'sale.updated',before,after);return {id};});this.notify();return result;
  }
  async cancel(user:AuthUser,id:string,input:unknown) {
    this.authorize(user,true);z.string().uuid().parse(id);const data=cancelSchema.parse(input);
    const result=await this.transaction(async tx=>{const before=await tx.pLSale.findFirst({where:{id,tenant_id:user.tenantId}});if(!before)throw new NotFoundException('Venda não encontrada');const changed=await tx.pLSale.updateMany({where:{id,tenant_id:user.tenantId,version:data.expectedVersion,status:'ACTIVE'},data:{status:'CANCELLED',version:{increment:1},updated_by:user.id}});if(changed.count!==1)throw new ConflictException('Venda já cancelada ou alterada. Atualize a página');await this.audit(tx,user,id,'sale.cancelled',before,{status:'CANCELLED',reason:data.reason});return {id};});this.notify();return result;
  }
  async goal(user:AuthUser,month:string,owner:string,input:unknown) {
    this.authorize(user,true);monthSchema.parse(month);if(owner!=='team')z.string().uuid().parse(owner);const data=plGoalSchema.parse(input);
    const result=await this.transaction(async tx=>{let name='Equipe PL';if(owner!=='team'){const seller=await tx.user.findFirst({where:{tenant_id:user.tenantId,id:owner,...sellerWhere},select:{nome:true}});if(!seller)throw new BadRequestException('Vendedora inválida');name=seller.nome;}const key={tenant_id:user.tenantId,month,owner_key:owner};const before=await tx.pLMonthlyGoal.findUnique({where:{tenant_id_month_owner_key:key}});if((before?.version??0)!==data.expectedVersion)throw new ConflictException('Meta alterada. Atualize a página');const after=before?await tx.pLMonthlyGoal.update({where:{id:before.id},data:{amount:data.amount,owner_name:name,updated_by:user.id,version:{increment:1}}}):await tx.pLMonthlyGoal.create({data:{...key,owner_name:name,amount:data.amount,updated_by:user.id}});await this.audit(tx,user,after.id,'goal.saved',before,after);return {id:after.id};});this.notify();return result;
  }
  async history(user:AuthUser) {this.authorize(user,true);return this.prisma.pLSalesAudit.findMany({where:{tenant_id:user.tenantId},orderBy:{created_at:'desc'},take:100});}
}
