/**
 * Derivação de status de cobrança — funções PURAS, sem Prisma e sem relógio
 * implícito (mesmo padrão de `broadcasts/broadcast-window.ts`, que também recebe
 * o `timeZone` por parâmetro em vez de assumir o fuso do processo).
 */

export type BillingStatus = 'sem_cobranca' | 'em_dia' | 'vence_em_breve' | 'vencido';

const DAY_MS = 86_400_000;

/**
 * Dia calendário de `x` NO FUSO `tz`, normalizado como timestamp UTC de meia-noite
 * (serve só de rótulo para subtrair dois dias). Usar `getUTC*` direto contaria o
 * dia errado: às 21h30 de São Paulo já é o dia seguinte em UTC, e um vencimento
 * de hoje apareceria como "vencido há 1 dia" durante a noite inteira.
 *
 * Exportada porque o service precisa da MESMA noção de "hoje" ao renovar um
 * vencimento (`markTenantPaid`) — duas definições de dia divergiriam justamente
 * na faixa das 21h à meia-noite, que é quando o bug aparece.
 */
export const dayInTz = (x: Date, tz: string): number => {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(x)
    .split('-')
    .map(Number);
  return Date.UTC(y, m - 1, d);
};

export function deriveBillingStatus(
  t: { billing_value: number | null; billing_cycle_months: number | null; billing_paid_until: Date | null },
  today: Date = new Date(),
  timeZone = 'America/Sao_Paulo',
): { status: BillingStatus; dias: number } {
  // Cobrança só existe com valor positivo, ciclo e vencimento. Ciclo 0/null
  // também cai aqui: sem ciclo não há como renovar nem normalizar o mensal.
  if (t.billing_value == null || t.billing_value <= 0) return { status: 'sem_cobranca', dias: 0 };
  if (!t.billing_cycle_months || t.billing_paid_until == null) return { status: 'sem_cobranca', dias: 0 };

  // Invalid Date (`new Date('lixo')`) devolve NaN em getTime() e faria o Intl
  // lançar RangeError; tratamos como "sem cobrança" em vez de quebrar a listagem.
  if (Number.isNaN(t.billing_paid_until.getTime()) || Number.isNaN(today.getTime())) {
    return { status: 'sem_cobranca', dias: 0 };
  }

  const diff = Math.round((dayInTz(t.billing_paid_until, timeZone) - dayInTz(today, timeZone)) / DAY_MS);
  if (diff < 0) return { status: 'vencido', dias: -diff };
  if (diff <= 3) return { status: 'vence_em_breve', dias: diff };
  return { status: 'em_dia', dias: diff };
}

/**
 * Soma meses ancorando o resultado ao MEIO-DIA UTC. A coluna é TIMESTAMP(3) naive
 * (sem fuso), então qualquer leitura com deslocamento de até ±12h continua caindo
 * no mesmo dia calendário — meia-noite UTC viraria o dia anterior em São Paulo.
 * Dia inexistente no mês destino clampa para o último dia (31/jan + 1 → 28/fev,
 * ou 29/fev em ano bissexto).
 */
export function addCycleMonths(from: Date, months: number): Date {
  const y = from.getUTCFullYear();
  const m = from.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(from.getUTCDate(), lastDay), 12));
}

export function monthlyCents(value: number, cycle: number): number {
  // Ciclo 0/NaN geraria Infinity/NaN e vazaria pra UI como "R$ Infinity".
  if (!cycle || !Number.isFinite(value / cycle)) return 0;
  return Math.round(value / cycle);
}
