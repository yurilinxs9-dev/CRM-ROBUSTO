import { compareLeadsInStage, topPositionFor, type OrderableLead } from './lead-order';

const lead = (position: number | null, ultima_interacao?: string): OrderableLead => ({
  position,
  ultima_interacao: ultima_interacao ?? null,
});

describe('compareLeadsInStage', () => {
  it('DISCRIMINANTE: a posição arrastada manda, mesmo com interação mais antiga', () => {
    // O card do topo tem conversa de ontem; o de baixo, de hoje. Antes a coluna
    // ordenava só por interação e o arrasto era desfeito na hora.
    const arrastadoParaTopo = lead(1000, '2026-08-09T12:00:00Z');
    const conversaRecente = lead(2000, '2026-08-10T12:00:00Z');

    expect([conversaRecente, arrastadoParaTopo].sort(compareLeadsInStage)).toEqual([
      arrastadoParaTopo,
      conversaRecente,
    ]);
  });

  it('posição menor fica acima, inclusive negativa (lead novo no topo)', () => {
    const novo = lead(-1000);
    const antigo = lead(1000);
    expect([antigo, novo].sort(compareLeadsInStage)).toEqual([novo, antigo]);
  });

  it('posições fracionárias entre vizinhos são respeitadas', () => {
    const a = lead(1000);
    const meio = lead(1500);
    const b = lead(2000);
    expect([b, a, meio].sort(compareLeadsInStage)).toEqual([a, meio, b]);
  });

  it('empate na posição cai para a interação mais recente', () => {
    const antigo = lead(1000, '2026-08-01T00:00:00Z');
    const recente = lead(1000, '2026-08-10T00:00:00Z');
    expect([antigo, recente].sort(compareLeadsInStage)).toEqual([recente, antigo]);
  });

  it('lead sem posição vai para o fim, não para o topo', () => {
    const semPosicao = lead(null, '2026-08-10T00:00:00Z');
    const comPosicao = lead(5000, '2026-01-01T00:00:00Z');
    expect([semPosicao, comPosicao].sort(compareLeadsInStage)).toEqual([
      comPosicao,
      semPosicao,
    ]);
  });
});

describe('topPositionFor', () => {
  it('fica abaixo do menor valor da coluna', () => {
    expect(topPositionFor([lead(1000), lead(3000)])).toBe(0);
    expect(topPositionFor([lead(-2000), lead(500)])).toBe(-3000);
  });

  it('coluna vazia começa em 1000', () => {
    expect(topPositionFor([])).toBe(1000);
  });

  it('ignora leads sem posição em vez de virar NaN', () => {
    expect(topPositionFor([lead(null), lead(2000)])).toBe(1000);
    expect(topPositionFor([lead(null)])).toBe(1000);
  });
});
