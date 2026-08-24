import { deriveBillingStatus, addCycleMonths, monthlyCents } from './billing-status';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('deriveBillingStatus', () => {
  const base = { billing_value: 30000, billing_cycle_months: 1 };

  it('sem_cobranca quando faltam valor ou paid_until', () => {
    expect(deriveBillingStatus({ billing_value: null, billing_cycle_months: null, billing_paid_until: null }).status).toBe('sem_cobranca');
    expect(deriveBillingStatus({ ...base, billing_cycle_months: 1, billing_paid_until: null }).status).toBe('sem_cobranca');
  });

  it('em_dia quando faltam mais de 3 dias', () => {
    const r = deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-30') }, d('2026-08-24'));
    expect(r).toEqual({ status: 'em_dia', dias: 6 });
  });

  it('vence_em_breve a 3 dias ou menos (limite inclusivo)', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-27') }, d('2026-08-24')).status).toBe('vence_em_breve');
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-24') }, d('2026-08-24'))).toEqual({ status: 'vence_em_breve', dias: 0 });
  });

  it('vencido com dias de atraso', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-20') }, d('2026-08-24'))).toEqual({ status: 'vencido', dias: 4 });
  });
});

describe('addCycleMonths', () => {
  it('soma meses simples', () => {
    expect(addCycleMonths(d('2026-08-10'), 1).toISOString().slice(0, 10)).toBe('2026-09-10');
  });
  it('clampa dia 31 para ultimo dia do mes destino', () => {
    expect(addCycleMonths(d('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
  it('vira ano no ciclo anual e trimestral', () => {
    expect(addCycleMonths(d('2026-08-24'), 12).toISOString().slice(0, 10)).toBe('2027-08-24');
    expect(addCycleMonths(d('2026-11-30'), 3).toISOString().slice(0, 10)).toBe('2027-02-28');
  });
});

describe('monthlyCents', () => {
  it('normaliza anual e trimestral para mensal', () => {
    expect(monthlyCents(120000, 12)).toBe(10000);
    expect(monthlyCents(100000, 3)).toBe(33333);
  });
});
