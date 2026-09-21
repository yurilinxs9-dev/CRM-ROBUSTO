import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { CrmGateway } from '../websocket/websocket.gateway';
import { assertPartnerTenant, buildSummary, businessToday, CADASTRO_STAGE_ID, money, monthDates } from './partners.domain';
import { createPartnerSchema, dateSchema, goalSchema, monthSchema, productionSchema, updatePartnerSchema } from './partners.schemas';
const dateValue = (v: string) => new Date(`${v}T00:00:00Z`);
const dateString = (v: Date) => v.toISOString().slice(0,10);
function parse<T>(schema: z.ZodType<T>, value: unknown): T { const result = schema.safeParse(value); if (!result.success) throw new BadRequestException(result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')); return result.data; }
function json(value: unknown): Prisma.InputJsonValue { return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue; }
@Injectable()
export class PartnersService {
  constructor(private readonly prisma: PrismaService, private readonly gateway: CrmGateway) {}
  private authorize(user: AuthUser, minimum: 'read'|'operator'|'manager' = 'read') {
    assertPartnerTenant(user.tenantId);
    const allowed = minimum === 'manager' ? ['GERENTE','SUPER_ADMIN'] : minimum === 'operator' ? ['OPERADOR','GERENTE','SUPER_ADMIN'] : ['VISUALIZADOR','OPERADOR','GERENTE','SUPER_ADMIN'];
    if (!allowed.includes(user.role)) throw new ForbiddenException('Permissão insuficiente');
  }
  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) { if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002','P2034'].includes(error.code)) throw new ConflictException('Registro alterado por outra pessoa. Recarregue antes de substituir.'); throw error; }
  }
  private notify(tenantId: string) { this.gateway.server?.to(`tenant:${tenantId}`).emit('partners:updated', {}); }
  private async partner(tx: Prisma.TransactionClient, tenantId: string, id: string) {
    parse(z.string().uuid(),id);
    const partner = await tx.salesPartner.findFirst({where:{id,tenant_id:tenantId}});
    if (!partner) throw new NotFoundException('Parceiro não encontrado'); return partner;
  }
  private async audit(tx: Prisma.TransactionClient, user: AuthUser, action: string, entityId: string, partnerId: string|null, before: unknown, after: unknown) {
    await tx.partnerProductionAudit.create({data:{tenant_id:user.tenantId,actor_id:user.id,action,entity_id:entityId,partner_id:partnerId,before:before === null ? Prisma.DbNull : json(before),after:json(after)}});
  }
  private async validateOwner(tx: Prisma.TransactionClient, tenantId: string, ownerId: string|null|undefined) {
    if (ownerId && !await tx.user.findFirst({where:{id:ownerId,tenant_id:tenantId,ativo:true},select:{id:true}})) throw new BadRequestException('Responsável não pertence ao workspace ou está inativo');
  }
  async dashboard(user: AuthUser, monthInput: unknown) {
    this.authorize(user); const today = businessToday(); const month = parse(monthSchema,monthInput ?? today.slice(0,7)); const dates = monthDates(month);
    const [partners, entries, goal, members] = await this.prisma.$transaction([
      this.prisma.salesPartner.findMany({where:{tenant_id:user.tenantId},include:{owner:{select:{nome:true}}},orderBy:{name:'asc'}}),
      this.prisma.partnerDailyProduction.findMany({where:{tenant_id:user.tenantId,date:{gte:dateValue(dates[0]),lte:dateValue(dates[dates.length-1])}},include:{actor:{select:{nome:true}}},orderBy:[{date:'asc'},{partner_id:'asc'}]}),
      this.prisma.partnerMonthlyGoal.findUnique({where:{tenant_id_month:{tenant_id:user.tenantId,month}}}),
      this.prisma.user.findMany({where:{tenant_id:user.tenantId,ativo:true},select:{id:true,nome:true},orderBy:{nome:'asc'}}),
    ],{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});
    const totals = new Map<string,Prisma.Decimal>(); const dailyTotals = new Map<string,Prisma.Decimal>(); let total = new Prisma.Decimal(0);
    for (const entry of entries) { total=total.plus(entry.amount); totals.set(entry.partner_id,(totals.get(entry.partner_id) ?? new Prisma.Decimal(0)).plus(entry.amount)); const date=dateString(entry.date); dailyTotals.set(date,(dailyTotals.get(date) ?? new Prisma.Decimal(0)).plus(entry.amount)); }
    let accumulated = new Prisma.Decimal(0);
    return {month,today,partners:partners.map(p => ({id:p.id,name:p.name,contact:p.contact,phone:p.phone,notes:p.notes,joined_on:dateString(p.joined_on),active:p.active,owner_id:p.owner_id,owner_name:p.owner?.nome ?? null,lead_id:p.lead_id,version:p.version,monthly_total:money(totals.get(p.id) ?? 0)})), entries:entries.map(e => ({id:e.id,partner_id:e.partner_id,date:dateString(e.date),amount:money(e.amount),note:e.note,version:e.version,updated_at:e.updated_at.toISOString(),updated_by_name:e.actor.nome})),goal:goal ? {amount:money(goal.amount),version:goal.version} : null, summary:buildSummary(month,today,money(total),goal ? money(goal.amount) : null,money(dailyTotals.get(today) ?? 0),partners.filter(p=>p.active).length,Array.from(totals.values()).filter(value => value.gt(0)).length),daily:dates.map(date => { const value=dailyTotals.get(date) ?? new Prisma.Decimal(0); accumulated=accumulated.plus(value); return {date,total:money(value),accumulated:money(accumulated)}; }), ranking:partners.filter(p => (totals.get(p.id) ?? new Prisma.Decimal(0)).gt(0)).sort((a,b)=>(totals.get(b.id) ?? new Prisma.Decimal(0)).comparedTo(totals.get(a.id) ?? 0) || a.name.localeCompare(b.name)).map(p=>({id:p.id,name:p.name,total:money(totals.get(p.id) ?? 0)})), members:members.map(m=>({id:m.id,name:m.nome}))};
  }
  async candidates(user: AuthUser, input: unknown) {
    this.authorize(user); const search=parse(z.string().trim().max(200),input ?? '');
    const leads=await this.prisma.lead.findMany({where:{tenant_id:user.tenantId,estagio_id:CADASTRO_STAGE_ID,sales_partners:{none:{}},...(search ? {OR:[{nome:{contains:search,mode:'insensitive' as const}},{telefone:{contains:search}}]} : {})},select:{id:true,nome:true,empresa:true,telefone:true},take:30,orderBy:{nome:'asc'}});
    return leads.map(l=>({id:l.id,name:l.nome,company:l.empresa,phone:l.telefone}));
  }
  async create(user: AuthUser, input: unknown) {
    this.authorize(user,'manager'); const data=parse(createPartnerSchema,input);
    const result=await this.transaction(async tx=>{ await this.validateOwner(tx,user.tenantId,data.owner_id); if(data.lead_id && !await tx.lead.findFirst({where:{id:data.lead_id,tenant_id:user.tenantId,estagio_id:CADASTRO_STAGE_ID},select:{id:true}})) throw new BadRequestException('Lead não pertence ao workspace ou à etapa Cadastro');
      const partner=await tx.salesPartner.create({data:{...data,joined_on:dateValue(data.joined_on),tenant_id:user.tenantId}}); await this.audit(tx,user,'partner.created',partner.id,partner.id,null,partner); return {...partner,joined_on:dateString(partner.joined_on)}; }); this.notify(user.tenantId); return result;
  }
  async update(user: AuthUser, id: string, input: unknown) {
    this.authorize(user,'manager'); const {expectedVersion,...data}=parse(updatePartnerSchema,input);
    const result=await this.transaction(async tx=>{ const before=await this.partner(tx,user.tenantId,id); await this.validateOwner(tx,user.tenantId,data.owner_id); const updated=await tx.salesPartner.updateMany({where:{id,tenant_id:user.tenantId,version:expectedVersion},data:{...data,...(data.joined_on ? {joined_on:dateValue(data.joined_on)} : {}),version:{increment:1}}}); if(updated.count !== 1) throw new ConflictException('Parceiro alterado. Recarregue antes de salvar'); const after=await this.partner(tx,user.tenantId,id); await this.audit(tx,user,'partner.updated',id,id,before,after); return {...after,joined_on:dateString(after.joined_on)}; }); this.notify(user.tenantId); return result;
  }
  async remove(user: AuthUser, id: string, input: unknown) {
    this.authorize(user, 'manager');
    const { expectedVersion } = parse(z.object({ expectedVersion: z.number().int().min(1) }).strict(), input);
    try {
      const result = await this.transaction(async tx => {
        const before = await this.partner(tx, user.tenantId, id);
        if (before.version !== expectedVersion) throw new ConflictException('Parceiro alterado. Recarregue antes de excluir.');
        // Check every month, including zero-value entries: no sales history is erased.
        if (await tx.partnerDailyProduction.findFirst({ where: { tenant_id: user.tenantId, partner_id: id }, select: { id: true } })) {
          throw new BadRequestException('Este parceiro possui lançamentos de vendas e não pode ser excluído. Use Editar para desativá-lo e preservar o histórico.');
        }
        if (await tx.partnerTeamActivity.findFirst({ where: { tenant_id: user.tenantId, OR: [{ partner_id: id }, ...(before.lead_id ? [{ lead_id: before.lead_id }] : [])] }, select: { id: true } })) throw new BadRequestException('Este parceiro possui histórico de atividades da equipe. Desative-o para preservar os resultados.');
        // Keep the audit snapshots and entity IDs, removing only the restrictive FK.
        await tx.partnerProductionAudit.updateMany({ where: { tenant_id: user.tenantId, partner_id: id }, data: { partner_id: null } });
        const deleted = await tx.salesPartner.deleteMany({ where: { id, tenant_id: user.tenantId, version: expectedVersion } });
        if (deleted.count !== 1) throw new ConflictException('Parceiro alterado. Recarregue antes de excluir.');
        await this.audit(tx, user, 'partner.deleted', id, null, before, { deleted: true, name: before.name });
        return { id, deleted: true };
      });
      this.notify(user.tenantId);
      return result;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2003') {
        throw new ConflictException('O parceiro recebeu um registro vinculado. Atualize a lista antes de continuar.');
      }
      throw error;
    }
  }
  async production(user: AuthUser, id: string, dateInput: unknown, input: unknown) {
    this.authorize(user,'operator'); const date=parse(dateSchema,dateInput); if(date>businessToday()) throw new BadRequestException('Datas futuras não são permitidas'); const data=parse(productionSchema,input);
    const result=await this.transaction(async tx=>{ const partner=await this.partner(tx,user.tenantId,id); const where={tenant_id_partner_id_date:{tenant_id:user.tenantId,partner_id:id,date:dateValue(date)}}; const before=await tx.partnerDailyProduction.findUnique({where});
      if(!partner.active) { if(!before) throw new BadRequestException('Parceiro inativo não recebe lançamento novo'); this.authorize(user,'manager'); }
      if((before?.version ?? 0)!==data.expectedVersion) throw new ConflictException('Lançamento alterado. Recarregue antes de substituir');
      let after;
      if(!before) after=await tx.partnerDailyProduction.create({data:{tenant_id:user.tenantId,partner_id:id,date:dateValue(date),amount:data.amount,note:data.note,updated_by:user.id}});
      else { const updated=await tx.partnerDailyProduction.updateMany({where:{id:before.id,tenant_id:user.tenantId,version:data.expectedVersion},data:{amount:data.amount,note:data.note ?? null,updated_by:user.id,version:{increment:1}}}); if(updated.count!==1) throw new ConflictException('Lançamento alterado. Recarregue antes de substituir'); after=await tx.partnerDailyProduction.findUniqueOrThrow({where}); }
      await this.audit(tx,user,'production.saved',after.id,id,before,after); return {id:after.id,partner_id:id,date,amount:money(after.amount),note:after.note,version:after.version,updated_at:after.updated_at.toISOString(),updated_by_name:user.nome}; }); this.notify(user.tenantId); return result;
  }
  async goal(user: AuthUser, monthInput: unknown, input: unknown) {
    this.authorize(user,'manager'); const month=parse(monthSchema,monthInput); const data=parse(goalSchema,input);
    const result=await this.transaction(async tx=>{ const where={tenant_id_month:{tenant_id:user.tenantId,month}}; const before=await tx.partnerMonthlyGoal.findUnique({where}); if((before?.version ?? 0)!==data.expectedVersion) throw new ConflictException('Meta alterada. Recarregue antes de salvar'); let after;
      if(!before) after=await tx.partnerMonthlyGoal.create({data:{tenant_id:user.tenantId,month,amount:data.amount,updated_by:user.id}});
      else {const updated=await tx.partnerMonthlyGoal.updateMany({where:{id:before.id,tenant_id:user.tenantId,version:data.expectedVersion},data:{amount:data.amount,updated_by:user.id,version:{increment:1}}}); if(updated.count!==1) throw new ConflictException('Meta alterada. Recarregue antes de salvar'); after=await tx.partnerMonthlyGoal.findUniqueOrThrow({where});}
      await this.audit(tx,user,'goal.saved',after.id,null,before,after); return {amount:money(after.amount),version:after.version}; }); this.notify(user.tenantId); return result;
  }
  async history(user: AuthUser, partnerId?: string) {
    this.authorize(user,'manager'); if(partnerId) await this.partner(this.prisma,user.tenantId,partnerId);
    const entries=await this.prisma.partnerProductionAudit.findMany({where:{tenant_id:user.tenantId,...(partnerId ? {partner_id:partnerId} : {})},include:{actor:{select:{nome:true}}},orderBy:{created_at:'desc'},take:100}); return entries.map(e=>({id:e.id,action:e.action,entity_id:e.entity_id,actor_name:e.actor.nome,created_at:e.created_at.toISOString(),before:e.before,after:e.after}));
  }
}

