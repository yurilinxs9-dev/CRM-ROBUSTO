import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AuthUser } from '../../common/types/auth-user';
import { authorizeFinance, calculateInstallments, FINANCE_TENANT, FINANCE_USER, installmentStatus, DEFAULT_DISTRIBUTION } from './finance.domain';
import { manualSchema, ruleSchema, installmentSchema } from './finance.schemas';
export const paloma: AuthUser = { id: FINANCE_USER, tenantId: FINANCE_TENANT, nome: 'Paloma', email: 'palomagomeslobato@gmail.com', role: 'GERENTE', ativo: true };
describe('financial rules', () => {
    it('calculates the exact 20-million example', () => { const r = calculateInstallments('20000000.00', '2026-01-15', DEFAULT_DISTRIBUTION); expect(r.total).toBe('100000.00'); expect(r.installments.map(i => i.amount)).toEqual(['40000.00', '20000.00', '20000.00', '10000.00', '10000.00']); expect(r.installments.map(i => i.due_on)).toEqual(['2026-01-31', '2026-02-28', '2026-03-31', '2026-04-30', '2026-05-31']); });
    it('handles year boundaries and leap years', () => { expect(calculateInstallments('100', '2027-12-31', DEFAULT_DISTRIBUTION).installments.map(i => i.due_on)).toEqual(['2027-12-31', '2028-01-31', '2028-02-29', '2028-03-31', '2028-04-30']); });
    it('preserves total cents and nonnegative installments for tiny and fractional amounts', () => { for (const amount of ['0.01', '1.01', '5.00', '10.00', '1234.57', '999999999999.99']) {
        const r = calculateInstallments(amount, '2026-09-21', DEFAULT_DISTRIBUTION);
        const sum = r.installments.reduce((s, i) => s.plus(i.amount), new Prisma.Decimal(0));
        expect(sum.toFixed(2)).toBe(new Prisma.Decimal(amount).mul('0.005').toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP).toFixed(2));
        expect(r.installments.every(i => new Prisma.Decimal(i.amount).gte(0))).toBe(true);
    } });
    it('supports a future validated distribution', () => { expect(ruleSchema.safeParse({ expectedVersion: 1, total_bps: 50, distribution: [20, 10, 10, 5, 5] }).success).toBe(true); expect(ruleSchema.safeParse({ expectedVersion: 1, total_bps: 50, distribution: [20, 10] }).success).toBe(false); expect(ruleSchema.safeParse({ expectedVersion: 1, total_bps: 50, distribution: [0, 50] }).success).toBe(false); });
    it('allows Paloma only, never admin role bypass', () => { expect(() => authorizeFinance(paloma)).not.toThrow(); for (const u of [{ ...paloma, id: 'other', role: 'SUPER_ADMIN' as const }, { ...paloma, tenantId: 'other' }, { ...paloma, ativo: false }])
        expect(() => authorizeFinance(u)).toThrow(ForbiddenException); });
    it('keeps paid installments paid after their due date and only considers past dates overdue', () => { expect(installmentStatus(null, new Date('2026-09-20'), '2026-09-21')).toBe('overdue'); expect(installmentStatus(null, new Date('2026-09-21'), '2026-09-21')).toBe('pending'); expect(installmentStatus(new Date('2026-09-21'), new Date('2026-08-31'), '2026-09-21')).toBe('received'); });
    it('rejects impossible dates, negative sales, tenant injection and missing version', () => { expect(manualSchema.safeParse({ requestId: FINANCE_USER, description: 'test', amount: '-1', closed_on: '2026-02-30' }).success).toBe(false); expect(installmentSchema.safeParse({ due_on: '2026-09-30' }).success).toBe(false); expect(installmentSchema.safeParse({ expectedVersion: 1, received_on: null, tenant_id: 'other' }).success).toBe(false); });
});
