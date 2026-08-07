import {
  toQueryParams,
  contarFiltrosAtivos,
  FILTROS_VAZIOS,
  type LeadPanelFilters,
} from './lead-filters';

/**
 * `toQueryParams` é o contrato entre o painel e o backend. Dois detalhes que
 * quebram em silêncio se alguém mexer:
 *
 * 1. Campo vazio tem que ser OMITIDO. `valor_min=` chegaria no backend como
 *    string vazia e, pior, cada combinação de vazios viraria uma chave de cache
 *    diferente para a MESMA consulta.
 * 2. Tags viram lista separada por vírgula — é o formato que `applyPanelFilters`
 *    espera do outro lado.
 */

function filtros(patch: Partial<LeadPanelFilters> = {}): LeadPanelFilters {
  return { ...FILTROS_VAZIOS, ...patch };
}

describe('toQueryParams', () => {
  it('sem filtro nenhum, nao manda parametro nenhum', () => {
    expect(toQueryParams(filtros())).toEqual({});
  });

  it('tags viram lista separada por virgula', () => {
    expect(toQueryParams(filtros({ tags: ['QUENTE', 'PREÇO'] }))).toEqual({
      tags: 'QUENTE,PREÇO',
    });
  });

  it('campos vazios ficam de fora', () => {
    const params = toQueryParams(filtros({ valor_min: '100', valor_max: '' }));
    expect(params).toEqual({ valor_min: '100' });
    expect('valor_max' in params).toBe(false);
  });

  it('manda tudo que foi preenchido', () => {
    expect(
      toQueryParams(
        filtros({
          tags: ['A'],
          created_from: '2026-08-01',
          created_to: '2026-08-07',
          valor_min: '1000',
          valor_max: '5000',
          tarefa: 'atrasada',
        }),
      ),
    ).toEqual({
      tags: 'A',
      created_from: '2026-08-01',
      created_to: '2026-08-07',
      valor_min: '1000',
      valor_max: '5000',
      tarefa: 'atrasada',
    });
  });
});

describe('contarFiltrosAtivos', () => {
  it('zero quando nada foi escolhido', () => {
    expect(contarFiltrosAtivos(filtros())).toBe(0);
  });

  it('cada tag conta uma', () => {
    expect(contarFiltrosAtivos(filtros({ tags: ['A', 'B', 'C'] }))).toBe(3);
  });

  // Período e valor são UM critério cada, mesmo com dois campos preenchidos —
  // senão a bolinha diria "2" para quem escolheu um intervalo só.
  it('periodo conta uma vez, com um ou dois campos', () => {
    expect(contarFiltrosAtivos(filtros({ created_from: '2026-08-01' }))).toBe(1);
    expect(
      contarFiltrosAtivos(filtros({ created_from: '2026-08-01', created_to: '2026-08-07' })),
    ).toBe(1);
  });

  it('valor conta uma vez, com um ou dois campos', () => {
    expect(contarFiltrosAtivos(filtros({ valor_min: '1' }))).toBe(1);
    expect(contarFiltrosAtivos(filtros({ valor_min: '1', valor_max: '2' }))).toBe(1);
  });

  it('soma tudo', () => {
    expect(
      contarFiltrosAtivos(
        filtros({ tags: ['A', 'B'], created_from: '2026-08-01', valor_max: '9', tarefa: 'sem' }),
      ),
    ).toBe(5);
  });
});
