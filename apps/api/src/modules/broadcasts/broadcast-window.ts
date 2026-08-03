/**
 * Janela de horário do disparo — função PURA, sem Prisma, sem relógio implícito
 * (mesmo padrão de `leads/lead-visibility.ts` e `webhooks/conversation-routing.ts`).
 *
 * Existe porque o dispatcher é `@Cron(EVERY_MINUTE)` sem nenhuma restrição de
 * horário: um follow-up iniciado às 18h seguia a madrugada inteira, mandando
 * mensagem de vendas às 3 da manhã. Isso é risco de o número ser denunciado.
 */

/** Segunda = 1 ... domingo = 7 (ISO-8601). */
const WEEKDAY_TO_ISO: Record<string, number> = {
  Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7,
};

/**
 * `startHour` é inclusivo e `endHour` exclusivo: 9–18 significa que 09:00
 * dispara e 18:00 não. Sem isso, "até as 18h" mandaria mensagem às 18:59.
 *
 * `hourCycle: 'h23'` é obrigatório: com `hour12: false` o Intl devolve "24"
 * para meia-noite em algumas plataformas, e a comparação numérica quebraria
 * silenciosamente numa janela que começa em 0.
 */
export function isWithinBroadcastWindow(
  now: Date,
  timeZone: string,
  startHour: number,
  endHour: number,
  activeDays: number[],
): boolean {
  if (activeDays.length === 0) return false;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour: 'numeric',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now);

  const hourRaw = parts.find((p) => p.type === 'hour')?.value;
  const weekdayRaw = parts.find((p) => p.type === 'weekday')?.value;
  if (hourRaw === undefined || weekdayRaw === undefined) return false;

  const isoDay = WEEKDAY_TO_ISO[weekdayRaw];
  if (isoDay === undefined || !activeDays.includes(isoDay)) return false;

  const hour = Number(hourRaw);
  return hour >= startHour && hour < endHour;
}
