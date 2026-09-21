import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PartnerTeamActivity, Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { CrmGateway } from '../websocket/websocket.gateway';
import { businessToday, monthDates } from './partners.domain';
import { monthSchema } from './partners.schemas';
import { authorizeTeam, consultantGoalSchema, parseTeam, teamCancelSchema, teamCreateSchema, teamDedupeKey, teamFilterSchema, teamManager, teamProgress, teamUpdateSchema } from './partner-team.domain';

type Tx = Prisma.TransactionClient;
const day = (value: string) => new Date(`${value}T00:00:00Z`);
const iso = (value: Date) => value.toISOString().slice(0, 10);
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value));
const serialize = (row: PartnerTeamActivity) => ({ ...row, occurred_on: iso(row.occurred_on) });

@Injectable()
export class PartnerTeamService {
  constructor(private readonly prisma: PrismaService, private readonly gateway: CrmGateway) {}
  private async transaction<T>(work: (tx: Tx) => Promise<T>) {
    try { return await this.prisma.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 }); }
    catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(e.code)) throw new ConflictException('Atividade já registrada ou alterada. Atualize o histórico antes de tentar novamente. Cadastros cancelados podem ser restaurados.');
      throw e;
    }
  }
  private notify(user: AuthUser) { this.gateway.server?.to(`tenant:${user.tenantId}`).emit('partners:updated', {}); }
  private async consultant(tx: Tx, user: AuthUser, id: string, existingId?: string) {
    if (!teamManager(user) && id !== user.id) throw new ForbiddenException('Você só pode registrar atividades em seu próprio nome.');
    const member = await tx.user.findFirst({ where: { id, tenant_id: user.tenantId, ...(existingId === id ? {} : { ativo: true }), role: { in: ['OPERADOR', 'GERENTE', 'SUPER_ADMIN'] } }, select: { id: true, nome: true } });
    if (!member) throw new BadRequestException('Selecione uma consultora ativa deste workspace.');
    return member;
  }
  private async audit(tx: Tx, user: AuthUser, action: string, entity: string, partner: string | null, before: unknown, after: unknown) {
    await tx.partnerProductionAudit.create({ data: { tenant_id: user.tenantId, actor_id: user.id, action, entity_id: entity, partner_id: partner, before: before === null ? Prisma.DbNull : json(before), after: json(after) } });
  }
  private async event(tx: Tx, user: AuthUser, id: string) {
    parseTeam(z.string().uuid(), id);
    const row = await tx.partnerTeamActivity.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!row) throw new NotFoundException('Atividade não encontrada.');
    if (!teamManager(user) && row.consultant_id !== user.id) throw new ForbiddenException('Você só pode corrigir suas próprias atividades.');
    return row;
  }
  private checkTime(date: string, time: string, kind: string) {
    const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
    if (kind !== 'registration' && date === businessToday() && time > now) throw new BadRequestException('O horário deve ser de uma atividade já realizada.');
  }
  async subjects(user: AuthUser, input: unknown) {
    authorizeTeam(user);
    const search = parseTeam(z.string().trim().max(200), input ?? '');
    const [partners, leads] = await Promise.all([
      this.prisma.salesPartner.findMany({ where: { tenant_id: user.tenantId, active: true, ...(search ? { OR: [{ name: { contains: search, mode: 'insensitive' } }, { contact: { contains: search, mode: 'insensitive' } }, { phone: { contains: search } }] } : {}) }, orderBy: { name: 'asc' }, take: 30 }),
      this.prisma.lead.findMany({ where: { tenant_id: user.tenantId, sales_partners: { none: {} }, ...(search ? { OR: [{ nome: { contains: search, mode: 'insensitive' } }, { empresa: { contains: search, mode: 'insensitive' } }, { telefone: { contains: search } }] } : {}) }, select: { id: true, nome: true, empresa: true, telefone: true }, orderBy: { nome: 'asc' }, take: 30 }),
    ]);
    return [...partners.map(p => ({ id: p.id, type: 'partner' as const, name: p.name, contact: p.contact, company: p.name, phone: p.phone })), ...leads.map(l => ({ id: l.id, type: 'lead' as const, name: l.empresa || l.nome, contact: l.nome, company: l.empresa || '', phone: l.telefone }))];
  }
  async create(user: AuthUser, input: unknown) {
    authorizeTeam(user, true);
    const data = parseTeam(teamCreateSchema, input);
    this.checkTime(data.occurred_on, data.occurred_time, data.kind);
    const row = await this.transaction(async tx => {
      const member = await this.consultant(tx, user, data.consultant_id);
      const retry = await tx.partnerTeamActivity.findUnique({ where: { tenant_id_request_id: { tenant_id: user.tenantId, request_id: data.request_id } } });
      if (retry) {
        if (retry.created_by !== user.id) throw new ConflictException('Identificador de registro já utilizado.');
        return retry;
      }
      let partner = data.subject_type === 'partner' ? await tx.salesPartner.findFirst({ where: { id: data.subject_id, tenant_id: user.tenantId } }) : await tx.salesPartner.findFirst({ where: { lead_id: data.subject_id, tenant_id: user.tenantId } });
      const leadId = data.subject_type === 'lead' ? data.subject_id : partner?.lead_id ?? null;
      const lead = leadId ? await tx.lead.findFirst({ where: { id: leadId, tenant_id: user.tenantId }, select: { id: true, nome: true, empresa: true, telefone: true } }) : null;
      if ((data.subject_type === 'partner' && !partner) || (data.subject_type === 'lead' && !lead)) throw new NotFoundException('Empresa ou contato não encontrado neste workspace.');
      if (partner && !partner.active) throw new BadRequestException('Parceiro inativo. Reative o cadastro antes de registrar uma atividade.');
      const subject_key = leadId ? `lead:${leadId}` : `partner:${partner!.id}`;
      const occurred_time = data.kind === 'registration' ? '00:00' : data.occurred_time;
      const dedupe_key = teamDedupeKey(data.kind, subject_key, data.occurred_on, occurred_time);
      const duplicate = await tx.partnerTeamActivity.findUnique({ where: { tenant_id_dedupe_key: { tenant_id: user.tenantId, dedupe_key } } });
      if (duplicate) throw new ConflictException(duplicate.cancelled ? 'Este registro está cancelado. Localize-o no histórico para restaurar ou corrigir.' : data.kind === 'registration' ? 'Este parceiro já possui cadastro efetivado. Corrija o registro existente; ele conta uma única vez.' : 'Já existe uma atividade deste tipo para a empresa neste dia e horário.');
      const company_name = partner?.name || data.company_name?.trim() || lead?.empresa?.trim() || (data.kind !== 'registration' ? lead?.nome : '');
      if (!company_name) throw new BadRequestException('Informe o nome da empresa para efetivar o cadastro.');
      if (data.kind === 'registration' && !partner) {
        partner = await tx.salesPartner.create({ data: { tenant_id: user.tenantId, name: company_name, contact: lead!.nome, phone: lead!.telefone, lead_id: lead!.id, owner_id: member.id, joined_on: day(data.occurred_on) } });
        await this.audit(tx, user, 'partner.created', partner.id, partner.id, null, partner);
      }
      if (data.kind === 'registration' && partner && !partner.owner_id) {
        const before = partner;
        partner = await tx.salesPartner.update({ where: { id: partner.id }, data: { owner_id: member.id, version: { increment: 1 } } });
        await this.audit(tx, user, 'partner.updated', partner.id, partner.id, before, partner);
      }
      const created = await tx.partnerTeamActivity.create({ data: { tenant_id: user.tenantId, request_id: data.request_id, kind: data.kind, subject_key, dedupe_key, partner_id: partner?.id ?? null, lead_id: leadId, company_name, consultant_id: member.id, consultant_name: member.nome.trim(), occurred_on: day(data.occurred_on), occurred_time, note: data.note, created_by: user.id, updated_by: user.id } });
      await this.audit(tx, user, 'team.activity.created', created.id, created.partner_id, null, created);
      return created;
    });
    this.notify(user); return serialize(row);
  }
  async update(user: AuthUser, id: string, input: unknown) {
    authorizeTeam(user, true); const data = parseTeam(teamUpdateSchema, input);
    const row = await this.transaction(async tx => {
      const before = await this.event(tx, user, id);
      if (before.cancelled) throw new BadRequestException('Restaure a atividade antes de corrigi-la.');
      const member = await this.consultant(tx, user, data.consultant_id, before.consultant_id);
      this.checkTime(data.occurred_on, data.occurred_time, before.kind);
      const occurred_time = before.kind === 'registration' ? '00:00' : data.occurred_time;
      const result = await tx.partnerTeamActivity.updateMany({ where: { id, tenant_id: user.tenantId, version: data.expectedVersion }, data: { consultant_id: member.id, consultant_name: member.nome.trim(), occurred_on: day(data.occurred_on), occurred_time, note: data.note, dedupe_key: teamDedupeKey(before.kind, before.subject_key, data.occurred_on, occurred_time), version: { increment: 1 }, updated_by: user.id } });
      if (result.count !== 1) throw new ConflictException('Atividade alterada. Atualize antes de salvar.');
      const after = await tx.partnerTeamActivity.findUniqueOrThrow({ where: { id } });
      await this.audit(tx, user, 'team.activity.updated', id, after.partner_id, before, after); return after;
    }); this.notify(user); return serialize(row);
  }
  async cancel(user: AuthUser, id: string, input: unknown) {
    authorizeTeam(user, true); const data = parseTeam(teamCancelSchema, input);
    const row = await this.transaction(async tx => {
      const before = await this.event(tx, user, id);
      const changed = await tx.partnerTeamActivity.updateMany({ where: { id, tenant_id: user.tenantId, version: data.expectedVersion }, data: { cancelled: data.cancelled, updated_by: user.id, version: { increment: 1 } } });
      if (changed.count !== 1) throw new ConflictException('Atividade alterada. Atualize o histórico.');
      const after = await tx.partnerTeamActivity.findUniqueOrThrow({ where: { id } });
      await this.audit(tx, user, data.cancelled ? 'team.activity.cancelled' : 'team.activity.restored', id, after.partner_id, before, { ...after, reason: data.reason }); return after;
    }); this.notify(user); return serialize(row);
  }
  async goal(user: AuthUser, consultantId: string, monthInput: unknown, input: unknown) {
    authorizeTeam(user, true); if (!teamManager(user)) throw new ForbiddenException('Somente a gestão define metas.');
    parseTeam(z.string().uuid(), consultantId); const month = parseTeam(monthSchema, monthInput); const data = parseTeam(consultantGoalSchema, input);
    const row = await this.transaction(async tx => {
      const key = { tenant_id_consultant_id_month: { tenant_id: user.tenantId, consultant_id: consultantId, month } };
      const before = await tx.partnerConsultantGoal.findUnique({ where: key });
      const member = await this.consultant(tx, user, consultantId, before?.consultant_id);
      if ((before?.version ?? 0) !== data.expectedVersion) throw new ConflictException('Meta alterada. Atualize antes de salvar.');
      const after = before ? await tx.partnerConsultantGoal.update({ where: key, data: { target: data.target, consultant_name: member.nome.trim(), updated_by: user.id, version: { increment: 1 } } }) : await tx.partnerConsultantGoal.create({ data: { tenant_id: user.tenantId, consultant_id: member.id, consultant_name: member.nome.trim(), month, target: data.target, updated_by: user.id } });
      await this.audit(tx, user, 'team.goal.saved', after.id, null, before, after); return after;
    }); this.notify(user); return row;
  }
  async dashboard(user: AuthUser, input: unknown) {
    authorizeTeam(user); const filter = parseTeam(teamFilterSchema, input); const days = monthDates(filter.month);
    const base = { tenant_id: user.tenantId, occurred_on: { gte: day(days[0]), lte: day(days[days.length - 1]) }, ...(filter.consultant_id ? { consultant_id: filter.consultant_id } : {}) };
    const historyWhere = { ...base, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status !== 'all' ? { cancelled: filter.status === 'cancelled' } : {}) };
    return this.prisma.$transaction(async tx => {
      const [members, counts, goals, rows, total] = await Promise.all([
        tx.user.findMany({ where: { tenant_id: user.tenantId, role: { in: ['OPERADOR', 'GERENTE', 'SUPER_ADMIN'] } }, select: { id: true, nome: true, ativo: true, role: true }, orderBy: { nome: 'asc' } }),
        tx.partnerTeamActivity.groupBy({ by: ['consultant_id', 'consultant_name', 'kind'], where: { ...base, cancelled: false }, _count: { _all: true } }),
        tx.partnerConsultantGoal.findMany({ where: { tenant_id: user.tenantId, month: filter.month, ...(filter.consultant_id ? { consultant_id: filter.consultant_id } : {}) } }),
        tx.partnerTeamActivity.findMany({ where: historyWhere, orderBy: [{ occurred_on: 'desc' }, { occurred_time: 'desc' }, { id: 'asc' }], skip: (filter.page - 1) * 30, take: 30 }),
        tx.partnerTeamActivity.count({ where: historyWhere }),
      ]);
      const people = new Map(members.map(m => [m.id, { id: m.id, name: m.nome.trim(), active: m.ativo, role: m.role as string }]));
      for (const row of [...counts, ...goals, ...rows]) if (!people.has(row.consultant_id)) people.set(row.consultant_id, { id: row.consultant_id, name: row.consultant_name, active: false, role: 'OPERADOR' });
      const performance = Array.from(people.values()).filter(m => (!filter.consultant_id || m.id === filter.consultant_id) && ((m.active && m.role === 'OPERADOR') || counts.some(c => c.consultant_id === m.id) || goals.some(g => g.consultant_id === m.id) || filter.consultant_id === m.id)).map(m => {
        const count = (kind: string) => counts.filter(c => c.consultant_id === m.id && c.kind === kind).reduce((sum, c) => sum + c._count._all, 0);
        const registrations = count('registration'); const goal = goals.find(g => g.consultant_id === m.id);
        return { ...m, meetings: count('meeting'), registrations, trainings: count('training'), goal_version: goal?.version ?? 0, ...teamProgress(registrations, goal?.target ?? null) };
      }).sort((a, b) => b.registrations - a.registrations || a.name.localeCompare(b.name));
      return { month: filter.month, today: businessToday(), members: Array.from(people.values()), performance, summary: { meetings: performance.reduce((s, r) => s + r.meetings, 0), registrations: performance.reduce((s, r) => s + r.registrations, 0), trainings: performance.reduce((s, r) => s + r.trainings, 0), target: goals.length ? goals.reduce((s, g) => s + g.target, 0) : null, goals_configured: goals.length }, history: { rows: rows.map(serialize), total, page: filter.page, pages: Math.max(1, Math.ceil(total / 30)) } };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead, timeout: 20000 });
  }
}
