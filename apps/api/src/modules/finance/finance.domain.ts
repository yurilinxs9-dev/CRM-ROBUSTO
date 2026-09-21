import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { AuthUser } from '../../common/types/auth-user';
export const FINANCE_TENANT = 'a44772ed-1382-4400-84fc-3fa350e23e42';
export const FINANCE_PLATFORM_OWNER = '6b854bc0-c935-45a1-b0b4-5a333703dc73';
export const FINANCE_USER = '4f72be61-f5a6-4222-bbfd-074c4da31b87';
export const DEFAULT_DISTRIBUTION = [20, 10, 10, 5, 5];
export function authorizeFinance(user: AuthUser) {
    if (!user.ativo || user.id !== FINANCE_USER || user.tenantId !== FINANCE_TENANT)
        throw new ForbiddenException('Financeiro indisponível para este usuário.');
}
export const parseFinance = <T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T => {
    const result = schema.safeParse(input);
    if (!result.success)
        throw new BadRequestException(result.error.issues.map(i => i.message).join('; '));
    return result.data;
};
export const money = (value: Prisma.Decimal.Value) => new Prisma.Decimal(value).toFixed(2);
export const dateValue = (value: string) => new Date(`${value}T00:00:00.000Z`);
export const dateString = (value: Date) => value.toISOString().slice(0, 10);
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
export function monthAt(month: string, offset: number) { return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + offset, 1)).toISOString().slice(0, 7); }
export function monthEnd(month: string) { return dateString(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))); }
export function calculateInstallments(amount: string, closed: string, distribution: number[]) {
    const cents = new Prisma.Decimal(amount).mul(100);
    const totalBps = distribution.reduce((a, b) => a + b, 0);
    const target = cents.mul(totalBps).div(10000).toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP);
    const raw = distribution.map(bps => cents.mul(bps).div(10000));
    const allocated = raw.map(v => v.floor());
    const remaining = target.minus(allocated.reduce((s, v) => s.plus(v), new Prisma.Decimal(0))).toNumber();
    const order = raw.map((v, i) => ({ i, remainder: v.minus(allocated[i]) })).sort((a, b) => b.remainder.comparedTo(a.remainder) || a.i - b.i);
    for (let i = 0; i < remaining; i++)
        allocated[order[i].i] = allocated[order[i].i].plus(1);
    return { total: money(target.div(100)), installments: distribution.map((bps, i) => ({ number: i + 1, rate_bps: bps, amount: money(allocated[i].div(100)), due_on: monthEnd(monthAt(closed.slice(0, 7), i)) })) };
}
export function installmentStatus(received: Date | null, due: Date, current = today()) { return received ? 'received' : dateString(due) < current ? 'overdue' : 'pending'; }
