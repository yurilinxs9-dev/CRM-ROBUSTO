import { buildSortOrder } from './lead-sort';

describe('buildSortOrder', () => {
  it('campo da whitelist vira orderBy com nulls last', () => {
    expect(buildSortOrder('valor_estimado', 'desc')).toEqual({
      valor_estimado: { sort: 'desc', nulls: 'last' },
    });
    expect(buildSortOrder('nome', 'asc')).toEqual({ nome: 'asc' });
    expect(buildSortOrder('created_at', 'asc')).toEqual({ created_at: 'asc' });
  });

  it('campos nullable do whitelist usam nulls last', () => {
    expect(buildSortOrder('ultima_interacao', 'desc')).toEqual({
      ultima_interacao: { sort: 'desc', nulls: 'last' },
    });
    expect(buildSortOrder('proximo_followup', 'asc')).toEqual({
      proximo_followup: { sort: 'asc', nulls: 'last' },
    });
  });

  // temperatura é enum NOT NULL no schema: Prisma só aceita SortOrder plano,
  // { sort, nulls } estouraria em runtime numa view salva.
  it('temperatura ordena como campo plano (enum NOT NULL)', () => {
    expect(buildSortOrder('temperatura', 'desc')).toEqual({ temperatura: 'desc' });
    expect(buildSortOrder('temperatura', 'asc')).toEqual({ temperatura: 'asc' });
  });

  it('fora da whitelist ou dir invalida -> null (ordenacao padrao)', () => {
    expect(buildSortOrder('dados_custom', 'asc')).toBeNull();
    expect(buildSortOrder('valor_estimado', 'up')).toBeNull();
    expect(buildSortOrder(undefined, undefined)).toBeNull();
  });
});
