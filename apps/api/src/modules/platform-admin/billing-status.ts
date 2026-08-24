export type BillingStatus = 'sem_cobranca' | 'em_dia' | 'vence_em_breve' | 'vencido';

const DAY_MS = 86_400_000;
const utcDay = (x: Date) => Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate());

export function deriveBillingStatus(
  t: { billing_value: number | null; billing_cycle_months: number | null; billing_paid_until: Date | null },
  today: Date = new Date(),
): { status: BillingStatus; dias: number } {
  if (t.billing_value == null || t.billing_paid_until == null) return { status: 'sem_cobranca', dias: 0 };
  const diff = Math.round((utcDay(t.billing_paid_until) - utcDay(today)) / DAY_MS);
  if (diff < 0) return { status: 'vencido', dias: -diff };
  if (diff <= 3) return { status: 'vence_em_breve', dias: diff };
  return { status: 'em_dia', dias: diff };
}

export function addCycleMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(from.getUTCDate(), lastDay), 12));
}

export function monthlyCents(value: number, cycle: number): number {
  return Math.round(value / cycle);
}
