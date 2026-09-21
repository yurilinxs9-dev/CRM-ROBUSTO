import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { FinanceSale, FinanceRule, Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { authorizeFinance, calculateInstallments, dateString, dateValue, DEFAULT_DISTRIBUTION, installmentStatus, money, monthAt, monthEnd, parseFinance, today } from './finance.domain';
import { dashboardSchema, historySchema, installmentSchema, manualSchema, manualUpdateSchema, reconcileSchema, ruleSchema, versionSchema } from './finance.schemas';
import { z } from 'zod';
type Tx = Prisma.TransactionClient;
const json = (v: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(v)) as Prisma.InputJsonValue;
@Injectable()
export class FinanceService {
    constructor(private readonly prisma: PrismaService) { }
    private async transaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> { try {
        return await this.prisma.$transaction(fn, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable, timeout: 20000 });
    }
    catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(e.code))
            throw new ConflictException('Os dados mudaram durante a operação. Atualize e tente novamente.');
        throw e;
    } }
    private async audit(tx: Tx, user: AuthUser, action: string, id: string, before: unknown, after: unknown) { await tx.financeAudit.create({ data: { tenant_id: user.tenantId, user_id: user.id, action, entity_id: id, before: before === null ? Prisma.DbNull : json(before), after: json(after) } }); }
    private async currentRule(tx: Tx, user: AuthUser) { const rule = await tx.financeRule.findFirst({ where: { tenant_id: user.tenantId }, orderBy: { version: 'desc' } }); if (rule)
        return rule; return tx.financeRule.create({ data: { tenant_id: user.tenantId, version: 1, total_bps: 50, distribution: DEFAULT_DISTRIBUTION, created_by: user.id } }); }
    async rule(user: AuthUser) { authorizeFinance(user); return this.transaction(tx => this.currentRule(tx, user)); }
    async updateRule(user: AuthUser, input: unknown) { authorizeFinance(user); const data = parseFinance(ruleSchema, input); return this.transaction(async (tx) => { const before = await this.currentRule(tx, user); if (before.version !== data.expectedVersion)
        throw new ConflictException('Regra alterada. Atualize antes de salvar.'); const after = await tx.financeRule.create({ data: { tenant_id: user.tenantId, created_by: user.id, version: before.version + 1, total_bps: data.total_bps, distribution: data.distribution } }); await this.audit(tx, user, 'rule.changed', after.id, before, after); return after; }); }
    private async createSale(tx: Tx, user: AuthUser, rule: FinanceRule, data: {
        source_type: string;
        source_key: string;
        source_version?: number;
        description: string;
        amount: string;
        closed_on: string;
    }) {
        const schedule = calculateInstallments(data.amount, data.closed_on, rule.distribution as number[]);
        const sale = await tx.financeSale.create({ data: { tenant_id: user.tenantId, source_type: data.source_type, source_key: data.source_key, source_version: data.source_version, description: data.description, amount: data.amount, closed_on: dateValue(data.closed_on), rule_id: rule.id, commission_total: schedule.total, created_by: user.id } });
        await tx.financeInstallment.createMany({ data: schedule.installments.map(i => ({ ...i, due_on: dateValue(i.due_on), tenant_id: user.tenantId, sale_id: sale.id })) });
        await this.audit(tx, user, 'sale.created', sale.id, null, sale);
        return sale;
    }
    async sync(user: AuthUser) {
        authorizeFinance(user);
        // The source is the actual daily sales ledger, never the prospect's declared volume.
        const sources = await this.prisma.partnerDailyProduction.findMany({ where: { tenant_id: user.tenantId }, include: { partner: { select: { name: true } } }, orderBy: { created_at: 'asc' } });
        let created = 0, review = 0;
        for (const source of sources) {
            await this.transaction(async (tx) => {
                const existing = await tx.financeSale.findUnique({ where: { tenant_id_source_type_source_key: { tenant_id: user.tenantId, source_type: 'partner', source_key: source.id } } });
                if (!existing) {
                    if (source.amount.lte(0))
                        return;
                    await this.createSale(tx, user, await this.currentRule(tx, user), { source_type: 'partner', source_key: source.id, source_version: source.version, description: `${source.partner.name} · ${dateString(source.date).split('-').reverse().join('/')}`, amount: money(source.amount), closed_on: dateString(source.date) });
                    created++;
                    return;
                }
                if (existing.source_version === source.version)
                    return;
                const changed = !existing.amount.equals(source.amount) || dateString(existing.closed_on) !== dateString(source.date);
                if (changed) {
                    if (!existing.needs_review) {
                        await tx.financeSale.update({ where: { id: existing.id }, data: { needs_review: true, version: { increment: 1 } } });
                        await this.audit(tx, user, 'source.changed', existing.id, { amount: money(existing.amount), date: dateString(existing.closed_on) }, { amount: money(source.amount), date: dateString(source.date) });
                    }
                    review++;
                }
                else if (!existing.needs_review)
                    await tx.financeSale.update({ where: { id: existing.id }, data: { source_version: source.version } });
            });
        }
        return { created, review };
    }
    async manual(user: AuthUser, input: unknown) { authorizeFinance(user); const data = parseFinance(manualSchema, input); return this.transaction(async (tx) => { const existing = await tx.financeSale.findUnique({ where: { tenant_id_source_type_source_key: { tenant_id: user.tenantId, source_type: 'manual', source_key: data.requestId } } }); if (existing) {
        if (!existing.amount.equals(data.amount) || dateString(existing.closed_on) !== data.closed_on || existing.description !== data.description)
            throw new ConflictException('Solicitação já utilizada com outros dados.');
        return this.serializeSale(existing);
    } return this.serializeSale(await this.createSale(tx, user, await this.currentRule(tx, user), { ...data, source_type: 'manual', source_key: data.requestId })); }); }
    private async sale(tx: Tx, user: AuthUser, id: string, version: number) { parseFinance(z.string().uuid(), id); const row = await tx.financeSale.findFirst({ where: { id, tenant_id: user.tenantId }, include: { rule: true, installments: true } }); if (!row)
        throw new NotFoundException('Venda não encontrada.'); if (row.version !== version)
        throw new ConflictException('Venda alterada. Atualize os dados.'); return row; }
    private assertUnpaid(installments: {
        received_on: Date | null;
    }[]) { if (installments.some(i => i.received_on))
        throw new BadRequestException('Há parcelas recebidas. Confira o histórico e desfaça o recebimento incorreto antes de alterar a venda.'); }
    private async reschedule(tx: Tx, user: AuthUser, sale: Awaited<ReturnType<FinanceService['sale']>>, amount: string, closed_on: string) {
        this.assertUnpaid(sale.installments);
        const schedule = calculateInstallments(amount, closed_on, sale.rule.distribution as number[]);
        for (const i of schedule.installments) {
            const old = sale.installments.find(v => v.number === i.number);
            if (!old)
                throw new ConflictException('Parcelas inconsistentes.');
            await tx.financeInstallment.update({ where: { id: old.id }, data: { amount: i.amount, ...(!old.due_overridden ? { due_on: dateValue(i.due_on) } : {}), version: { increment: 1 } } });
        }
        return schedule.total;
    }
    async updateManual(user: AuthUser, id: string, input: unknown) { authorizeFinance(user); const data = parseFinance(manualUpdateSchema, input); return this.transaction(async (tx) => { const before = await this.sale(tx, user, id, data.expectedVersion); if (before.source_type !== 'manual' || before.cancelled)
        throw new BadRequestException('Apenas vendas manuais ativas podem ser editadas.'); const total = await this.reschedule(tx, user, before, data.amount, data.closed_on); const after = await tx.financeSale.update({ where: { id }, data: { description: data.description, amount: data.amount, closed_on: dateValue(data.closed_on), commission_total: total, version: { increment: 1 } } }); await this.audit(tx, user, 'sale.updated', id, before, after); return this.serializeSale(after); }); }
    async reconcile(user: AuthUser, id: string, input: unknown) { authorizeFinance(user); const data = parseFinance(reconcileSchema, input); return this.transaction(async (tx) => { const before = await this.sale(tx, user, id, data.expectedVersion); if (before.source_type !== 'partner' || !before.needs_review)
        throw new BadRequestException('Não há alteração da origem para conciliar.'); const source = await tx.partnerDailyProduction.findFirst({ where: { id: before.source_key, tenant_id: user.tenantId } }); if (!source)
        throw new BadRequestException('Origem não encontrada.'); if (source.version !== data.expectedSourceVersion)
        throw new ConflictException('A origem mudou novamente. Atualize para conferir o novo valor.'); this.assertUnpaid(before.installments); const total = await this.reschedule(tx, user, before, money(source.amount), dateString(source.date)); const after = await tx.financeSale.update({ where: { id }, data: { amount: source.amount, closed_on: source.date, commission_total: total, source_version: source.version, needs_review: false, cancelled: source.amount.isZero(), version: { increment: 1 } } }); await this.audit(tx, user, 'source.reconciled', id, before, after); return this.serializeSale(after); }); }
    async cancel(user: AuthUser, id: string, input: unknown) { authorizeFinance(user); const data = parseFinance(versionSchema, input); return this.transaction(async (tx) => { const before = await this.sale(tx, user, id, data.expectedVersion); if (before.source_type !== 'manual' || before.cancelled)
        throw new BadRequestException('Apenas vendas manuais ativas podem ser canceladas.'); this.assertUnpaid(before.installments); const after = await tx.financeSale.update({ where: { id }, data: { cancelled: true, version: { increment: 1 } } }); await this.audit(tx, user, 'sale.cancelled', id, before, after); return { cancelled: true }; }); }
    async updateInstallment(user: AuthUser, id: string, input: unknown) {
        authorizeFinance(user);
        parseFinance(z.string().uuid(), id);
        const data = parseFinance(installmentSchema, input);
        return this.transaction(async (tx) => {
            const before = await tx.financeInstallment.findFirst({ where: { id, tenant_id: user.tenantId }, include: { sale: true } });
            if (!before)
                throw new NotFoundException('Parcela não encontrada.');
            if (before.version !== data.expectedVersion)
                throw new ConflictException('Parcela alterada. Atualize os dados.');
            if (before.sale.cancelled)
                throw new BadRequestException('Venda cancelada.');
            if (data.received_on && before.received_on)
                throw new ConflictException('Esta parcela já foi recebida. Desfaça a marcação para corrigir a data.');
            const after = await tx.financeInstallment.update({ where: { id }, data: { ...(data.due_on !== undefined ? { due_on: dateValue(data.due_on), due_overridden: true } : {}), ...(data.received_on !== undefined ? { received_on: data.received_on ? dateValue(data.received_on) : null, received_by: data.received_on ? user.id : null } : {}), version: { increment: 1 } } });
            await tx.financeSale.update({ where: { id: before.sale_id }, data: { version: { increment: 1 } } });
            await this.audit(tx, user, 'installment.updated', id, before, after);
            return this.serializeInstallment({ ...after, sale: before.sale });
        });
    }
    private serializeSale(sale: FinanceSale) { return { ...sale, amount: money(sale.amount), commission_total: money(sale.commission_total), closed_on: dateString(sale.closed_on) }; }
    private serializeInstallment(row: Prisma.FinanceInstallmentGetPayload<{
        include: {
            sale: true;
        };
    }>) { return { id: row.id, sale_id: row.sale_id, description: row.sale.description, source_type: row.sale.source_type, number: row.number, rate_bps: row.rate_bps, amount: money(row.amount), due_on: dateString(row.due_on), due_overridden: row.due_overridden, received_on: row.received_on ? dateString(row.received_on) : null, status: installmentStatus(row.received_on, row.due_on), version: row.version }; }
    async dashboard(user: AuthUser, input: unknown) {
        authorizeFinance(user);
        const { month, months } = parseFinance(dashboardSchema, input);
        const start = dateValue(month + '-01'), end = dateValue(monthAt(month, months) + '-01');
        const [rows, overdue, reviewCount, rule] = await Promise.all([
            this.prisma.financeInstallment.findMany({ where: { tenant_id: user.tenantId, sale: { cancelled: false }, OR: [{ due_on: { gte: start, lt: end } }, { received_on: { gte: start, lt: end } }] }, include: { sale: true }, orderBy: [{ due_on: 'asc' }, { number: 'asc' }] }),
            this.prisma.financeInstallment.aggregate({ where: { tenant_id: user.tenantId, sale: { cancelled: false }, received_on: null, due_on: { lt: dateValue(today()) } }, _count: true, _sum: { amount: true } }),
            this.prisma.financeSale.count({ where: { tenant_id: user.tenantId, needs_review: true } }), this.rule(user)
        ]);
        const monthly = Array.from({ length: months }, (_, offset) => { const m = monthAt(month, offset); const due = rows.filter(r => dateString(r.due_on).startsWith(m)); const received = rows.filter(r => r.received_on && dateString(r.received_on).startsWith(m)); const sum = (rs: typeof rows) => money(rs.reduce((s, r) => s.plus(r.amount), new Prisma.Decimal(0))); return { month: m, expected: sum(due), received: sum(received), settled: sum(due.filter(r => r.received_on)), pending: sum(due.filter(r => !r.received_on)), sales_count: new Set(due.map(r => r.sale_id)).size, installments: due.map(r => this.serializeInstallment(r)) }; });
        return { month, months, today: today(), rule, monthly, received_total: money(monthly.reduce((s, m) => s.plus(m.received), new Prisma.Decimal(0))), projection_total: money(monthly.reduce((s, m) => s.plus(m.expected), new Prisma.Decimal(0))), pending_total: money(monthly.reduce((s, m) => s.plus(m.pending), new Prisma.Decimal(0))), overdue: { count: overdue._count, amount: money(overdue._sum.amount ?? 0) }, review_count: reviewCount };
    }
    async history(user: AuthUser, input: unknown) { authorizeFinance(user); const q = parseFinance(historySchema, input); const where: Prisma.FinanceInstallmentWhereInput = { tenant_id: user.tenantId, sale: { cancelled: false }, ...(q.sale_id ? { sale_id: q.sale_id } : {}), ...(q.month ? { due_on: { gte: dateValue(q.month + '-01'), lte: dateValue(monthEnd(q.month)) } } : {}), ...(q.status === 'received' ? { received_on: { not: null } } : {}), ...(['pending', 'overdue'].includes(q.status) ? { received_on: null } : {}), ...(q.status === 'overdue' ? { AND: [{ due_on: { lt: dateValue(today()) } }] } : {}) }; const [total, rows] = await this.prisma.$transaction([this.prisma.financeInstallment.count({ where }), this.prisma.financeInstallment.findMany({ where, include: { sale: true }, orderBy: [{ due_on: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * 50, take: 50 })]); return { total, page: q.page, rows: rows.map(r => this.serializeInstallment(r)) }; }
    async sales(user: AuthUser) {
        authorizeFinance(user);
        const sales = await this.prisma.financeSale.findMany({ where: { tenant_id: user.tenantId }, orderBy: { closed_on: 'desc' }, include: { _count: { select: { installments: true } } } });
        const keys = sales.filter(s => s.needs_review && s.source_type === 'partner').map(s => s.source_key);
        const sources = keys.length ? await this.prisma.partnerDailyProduction.findMany({ where: { tenant_id: user.tenantId, id: { in: keys } }, select: { id: true, amount: true, date: true, version: true } }) : [];
        return sales.map(s => { const source = sources.find(p => p.id === s.source_key); return { ...this.serializeSale(s), installment_count: s._count.installments, source_current: source ? { amount: money(source.amount), closed_on: dateString(source.date), version: source.version } : null }; });
    }
    async auditHistory(user: AuthUser) { authorizeFinance(user); return this.prisma.financeAudit.findMany({ where: { tenant_id: user.tenantId }, orderBy: { created_at: 'desc' }, take: 100 }); }
}
