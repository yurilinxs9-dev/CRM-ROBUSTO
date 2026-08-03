import { isWithinBroadcastWindow } from './broadcast-window';

const TZ = 'America/Sao_Paulo';
const COMERCIAL = { start: 9, end: 18, days: [1, 2, 3, 4, 5] };

// BRT = UTC-3. 12:00Z = 09:00 em São Paulo.
const at = (utc: string) => new Date(utc);

const dentro = (utc: string) =>
  isWithinBroadcastWindow(at(utc), TZ, COMERCIAL.start, COMERCIAL.end, COMERCIAL.days);

describe('isWithinBroadcastWindow', () => {
  it('segunda 09:00 BRT está dentro (limite inferior é inclusivo)', () => {
    expect(dentro('2026-08-03T12:00:00Z')).toBe(true);
  });

  it('segunda 14:30 BRT está dentro', () => {
    expect(dentro('2026-08-03T17:30:00Z')).toBe(true);
  });

  it('segunda 17:59 BRT ainda está dentro', () => {
    expect(dentro('2026-08-03T20:59:00Z')).toBe(true);
  });

  it('segunda 18:00 BRT está FORA (limite superior é exclusivo)', () => {
    expect(dentro('2026-08-03T21:00:00Z')).toBe(false);
  });

  it('segunda 08:59 BRT está fora', () => {
    expect(dentro('2026-08-03T11:59:00Z')).toBe(false);
  });

  it('madrugada de terça está fora', () => {
    expect(dentro('2026-08-04T06:00:00Z')).toBe(false);
  });

  it('sábado no meio do horário comercial está fora', () => {
    // 2026-08-08 é sábado.
    expect(dentro('2026-08-08T17:00:00Z')).toBe(false);
  });

  it('domingo está fora', () => {
    // 2026-08-09 é domingo.
    expect(dentro('2026-08-09T17:00:00Z')).toBe(false);
  });

  it('janela que inclui sábado aceita sábado', () => {
    expect(
      isWithinBroadcastWindow(at('2026-08-08T17:00:00Z'), TZ, 9, 18, [1, 2, 3, 4, 5, 6]),
    ).toBe(true);
  });

  it('lista de dias vazia nunca dispara', () => {
    expect(isWithinBroadcastWindow(at('2026-08-03T17:00:00Z'), TZ, 9, 18, [])).toBe(false);
  });

  it('meia-noite BRT não é confundida com hora 24', () => {
    // 03:00Z = 00:00 BRT. Uma janela 0-6 tem que aceitar.
    expect(isWithinBroadcastWindow(at('2026-08-04T03:00:00Z'), TZ, 0, 6, [1, 2, 3, 4, 5])).toBe(true);
  });

  it('respeita o fuso: 21:00Z é 18:00 BRT (fora) mas 21:00 em UTC (dentro)', () => {
    const d = at('2026-08-03T21:00:00Z');
    expect(isWithinBroadcastWindow(d, 'America/Sao_Paulo', 9, 18, [1, 2, 3, 4, 5])).toBe(false);
    expect(isWithinBroadcastWindow(d, 'UTC', 9, 22, [1, 2, 3, 4, 5])).toBe(true);
  });

  it('terça 02:00 UTC ainda é segunda 23:00 no fuso — dia da semana vem do mesmo instante formatado', () => {
    // 2026-08-04T02:00:00Z é terça em UTC, mas segunda 23:00 em BRT.
    // Com a janela [1] (só segunda) das 22h às 24h, a função correta aceita.
    // Se o dia da semana viesse de now.getUTCDay() (terça = 2), recusaria.
    expect(isWithinBroadcastWindow(at('2026-08-04T02:00:00Z'), TZ, 22, 24, [1])).toBe(true);
  });
});
