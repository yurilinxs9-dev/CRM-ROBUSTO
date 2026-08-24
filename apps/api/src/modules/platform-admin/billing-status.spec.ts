import { deriveBillingStatus, addCycleMonths, monthlyCents } from './billing-status';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

describe('deriveBillingStatus', () => {
  const base = { billing_value: 30000, billing_cycle_months: 1 };

  it('sem_cobranca quando faltam valor ou paid_until', () => {
    expect(deriveBillingStatus({ billing_value: null, billing_cycle_months: null, billing_paid_until: null }).status).toBe('sem_cobranca');
    expect(deriveBillingStatus({ ...base, billing_paid_until: null }).status).toBe('sem_cobranca');
  });

  it('sem_cobranca quando ha valor mas falta o ciclo', () => {
    expect(
      deriveBillingStatus({ billing_value: 30000, billing_cycle_months: null, billing_paid_until: d('2026-08-30') }, d('2026-08-24')),
    ).toEqual({ status: 'sem_cobranca', dias: 0 });
  });

  it('sem_cobranca quando o valor e zero ou negativo', () => {
    expect(deriveBillingStatus({ ...base, billing_value: 0, billing_paid_until: d('2026-08-30') }, d('2026-08-24'))).toEqual({
      status: 'sem_cobranca',
      dias: 0,
    });
    expect(deriveBillingStatus({ ...base, billing_value: -1, billing_paid_until: d('2026-08-30') }, d('2026-08-24'))).toEqual({
      status: 'sem_cobranca',
      dias: 0,
    });
  });

  it('sem_cobranca quando o ciclo e zero', () => {
    expect(
      deriveBillingStatus({ billing_value: 30000, billing_cycle_months: 0, billing_paid_until: d('2026-08-30') }, d('2026-08-24')),
    ).toEqual({ status: 'sem_cobranca', dias: 0 });
  });

  it('sem_cobranca quando alguma data e Invalid Date', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: new Date('nao-e-data') }, d('2026-08-24'))).toEqual({
      status: 'sem_cobranca',
      dias: 0,
    });
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-30') }, new Date('nao-e-data'))).toEqual({
      status: 'sem_cobranca',
      dias: 0,
    });
  });

  it('em_dia quando faltam mais de 3 dias', () => {
    const r = deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-30') }, d('2026-08-24'));
    expect(r).toEqual({ status: 'em_dia', dias: 6 });
  });

  it('em_dia no primeiro dia fora da janela de aviso (diff = 4)', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-28') }, d('2026-08-24'))).toEqual({
      status: 'em_dia',
      dias: 4,
    });
  });

  it('vence_em_breve a 3 dias ou menos (limite inclusivo)', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-27') }, d('2026-08-24')).status).toBe('vence_em_breve');
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-24') }, d('2026-08-24'))).toEqual({ status: 'vence_em_breve', dias: 0 });
  });

  it('vencido com dias de atraso', () => {
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-20') }, d('2026-08-24'))).toEqual({ status: 'vencido', dias: 4 });
  });

  it('usa o dia calendario de America/Sao_Paulo, nao o de UTC', () => {
    // 2026-08-25T00:30:00Z = 24/08 21:30 em Sao_Paulo: ainda e o dia do vencimento.
    const today = new Date('2026-08-25T00:30:00Z');
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-24') }, today)).toEqual({
      status: 'vence_em_breve',
      dias: 0,
    });
  });

  it('aceita outro fuso quando informado explicitamente', () => {
    // Mesmo instante, em UTC, ja e 25/08: o vencimento em 24/08 esta 1 dia atrasado.
    const today = new Date('2026-08-25T00:30:00Z');
    expect(deriveBillingStatus({ ...base, billing_paid_until: d('2026-08-24') }, today, 'UTC')).toEqual({
      status: 'vencido',
      dias: 1,
    });
  });
});

describe('addCycleMonths', () => {
  it('soma meses simples ancorando ao meio-dia UTC', () => {
    expect(addCycleMonths(d('2026-08-10'), 1).toISOString()).toBe('2026-09-10T12:00:00.000Z');
  });
  it('clampa dia 31 para ultimo dia do mes destino', () => {
    expect(addCycleMonths(d('2026-01-31'), 1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
  it('respeita ano bissexto no clamp', () => {
    expect(addCycleMonths(d('2028-01-31'), 1).toISOString().slice(0, 10)).toBe('2028-02-29');
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
  it('devolve 0 para ciclo invalido em vez de Infinity/NaN', () => {
    expect(monthlyCents(30000, 0)).toBe(0);
    expect(monthlyCents(30000, Number.NaN)).toBe(0);
  });
});
