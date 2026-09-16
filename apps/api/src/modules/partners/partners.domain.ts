import { ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
export const PARTNER_TENANT_ID = 'a44772ed-1382-4400-84fc-3fa350e23e42';
export const CADASTRO_STAGE_ID = '8c5ca72b-8e29-4ad8-aa3c-6ffb98dc158a';
export function assertPartnerTenant(tenantId: string) { if (tenantId !== PARTNER_TENANT_ID) throw new ForbiddenException('Parceiros indisponível neste workspace'); }
export function businessToday(now = new Date()) { return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo', year: 'numeric', month:'2-digit', day:'2-digit' }).format(now); }
export function money(value: Prisma.Decimal.Value) { return new Prisma.Decimal(value).toFixed(2); }
export function monthDates(month: string) { const [year, m] = month.split('-').map(Number); const count = new Date(Date.UTC(year,m,0)).getUTCDate(); return Array.from({length: count}, (_,i) => `${month}-${String(i+1).padStart(2,'0')}`); }
export function buildSummary(month: string, today: string, total: string, target: string|null, todayTotal: string, active: number, producing: number) {
  const dates = monthDates(month); const days = month < today.slice(0,7) ? 0 : month > today.slice(0,7) ? dates.length : dates.length - Number(today.slice(8)) + 1;
  const t = new Prisma.Decimal(total); const g = target === null ? null : new Prisma.Decimal(target); const remaining = g === null ? null : Prisma.Decimal.max(g.minus(t),0); const excess = g === null ? new Prisma.Decimal(0) : Prisma.Decimal.max(t.minus(g),0);
  return { total:money(t), today_total:money(todayTotal), target:g === null ? null : money(g), remaining:remaining === null ? null : money(remaining), excess:money(excess), percentage:g === null || g.isZero() ? null : t.div(g).times(100).toNumber(), days_remaining:days, required_per_day:remaining === null || days === 0 ? null : money(remaining.div(days)), active_partners:active, producing_partners:producing };
}
