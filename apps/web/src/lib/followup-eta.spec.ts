import { estimateFinish } from './followup-eta';

const JANELA = { start: 9, end: 18, days: [1, 2, 3, 4, 5] };
const BASE = { throttleSeconds: 900, dailyLimit: 30, sentToday: 0, janela: JANELA };

// 2026-08-03 é uma segunda-feira. 13:00Z = 10:00 BRT.
const SEGUNDA_10H = new Date('2026-08-03T13:00:00Z');
const SEGUNDA_3H = new Date('2026-08-03T06:00:00Z');
const SEXTA_17H = new Date('2026-08-07T20:00:00Z');
const SABADO_10H = new Date('2026-08-08T13:00:00Z');

describe('estimateFinish', () => {
  it('sem pendentes, não estima nada', () => {
    expect(estimateFinish({ ...BASE, pending: 0, agora: SEGUNDA_10H })).toBeNull();
  });

  it('dentro da janela, cabe tudo hoje: conta os intervalos que faltam', () => {
    // 4 pendentes: o 1º sai agora, os outros 3 esperam 15min cada = 45min.
    expect(estimateFinish({ ...BASE, pending: 4, agora: SEGUNDA_10H })).toEqual({
      paused: false,
      label: '~45min',
    });
  });

  it('fora da janela no mesmo dia, diz até quando espera', () => {
    expect(estimateFinish({ ...BASE, pending: 4, agora: SEGUNDA_3H })).toEqual({
      paused: true,
      label: 'pausado até as 9h',
    });
  });

  it('em dia inativo, aponta o próximo dia ativo', () => {
    expect(estimateFinish({ ...BASE, pending: 4, agora: SABADO_10H })).toEqual({
      paused: true,
      label: 'pausado até seg às 9h',
    });
  });

  it('não promete terminar hoje o que a janela não comporta', () => {
    // Sexta 17:00, janela fecha às 18:00: cabem 4 envios (agora + 3 x 15min).
    // Os 16 restantes só saem na segunda — dizer "~5h" seria mentira, e
    // "~2 dias" cairia no sábado, que não é dia de disparo. Dizer o dia é a
    // única forma honesta quando a fila atravessa o fim de semana.
    const r = estimateFinish({ ...BASE, pending: 20, agora: SEXTA_17H });
    expect(r).toEqual({ paused: false, label: 'termina seg' });
  });

  it('limite diário já batido termina no próximo dia ativo', () => {
    const r = estimateFinish({ ...BASE, pending: 5, sentToday: 30, agora: SEGUNDA_10H });
    expect(r).toEqual({ paused: false, label: 'termina ter' });
  });

  it('janela curta limita a capacidade do dia mais que o limite diário', () => {
    // Janela de 1h com throttle de 15min comporta 4 envios/dia, não 30:
    // 2 hoje (09:30 e 09:45), depois 4 por dia — acaba na quinta.
    const r = estimateFinish({
      ...BASE,
      janela: { start: 9, end: 10, days: [1, 2, 3, 4, 5] },
      pending: 12,
      agora: new Date('2026-08-03T12:30:00Z'), // 09:30 BRT
    });
    expect(r).toEqual({ paused: false, label: 'termina qui' });
  });

  it('fila que passa de uma semana não finge precisão', () => {
    const r = estimateFinish({ ...BASE, pending: 500, agora: SEGUNDA_10H });
    expect(r).toEqual({ paused: false, label: 'mais de uma semana' });
  });

  it('lista de dias vazia não trava o cálculo', () => {
    // Estado impossível pela API, mas dado antigo pode chegar assim — não pode
    // virar laço infinito procurando o próximo dia ativo.
    const r = estimateFinish({ ...BASE, janela: { start: 9, end: 18, days: [] }, pending: 3, agora: SEGUNDA_10H });
    expect(r).toEqual({ paused: true, label: 'sem dias de disparo configurados' });
  });
});
