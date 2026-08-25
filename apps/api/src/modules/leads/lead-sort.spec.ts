import { buildSortOrder } from './lead-sort';

describe('buildSortOrder', () => {
  it('campo da whitelist vira orderBy com nulls last', () => {
    expect(buildSortOrder('valor_estimado', 'desc')).toEqual({
      valor_estimado: { sort: 'desc', nulls: 'last' },
    });
    expect(buildSortOrder('nome', 'asc')).toEqual({ nome: 'asc' });
    expect(buildSortOrder('created_at', 'asc')).toEqual({ created_at: 'asc' });
  });

  it('fora da whitelist ou dir invalida -> null (ordenacao padrao)', () => {
    expect(buildSortOrder('dados_custom', 'asc')).toBeNull();
    expect(buildSortOrder('valor_estimado', 'up')).toBeNull();
    expect(buildSortOrder(undefined, undefined)).toBeNull();
  });
});
