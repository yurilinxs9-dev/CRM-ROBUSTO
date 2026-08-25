import { fromSavedConfig, configIgual, CONFIG_VAZIA } from './lead-view-config';

describe('fromSavedConfig', () => {
  it('json solto vira defaults', () => {
    expect(fromSavedConfig(null)).toEqual(CONFIG_VAZIA);
    expect(fromSavedConfig('lixo')).toEqual(CONFIG_VAZIA);
    expect(fromSavedConfig([])).toEqual(CONFIG_VAZIA);
  });

  it('hidrata config completa', () => {
    const c = fromSavedConfig({
      tipo_padrao: 'lista',
      sort: { campo: 'valor_estimado', dir: 'desc' },
      colunas: [{ key: 'nome', width: 240 }, { key: 'x_cnpj' }],
      card_fields: ['valor_estimado', 'tags'],
    });
    expect(c.tipo_padrao).toBe('lista');
    expect(c.sort).toEqual({ campo: 'valor_estimado', dir: 'desc' });
    expect(c.colunas).toEqual([{ key: 'nome', width: 240 }, { key: 'x_cnpj' }]);
    expect(c.card_fields).toEqual(['valor_estimado', 'tags']);
  });

  it('valor fora do domínio cai no default, sem derrubar o resto', () => {
    const c = fromSavedConfig({
      tipo_padrao: 'grafico',
      sort: { campo: 'nome', dir: 'sideways' },
      colunas: [{ key: '' }, { key: 'nome', width: 'larga' }, 42],
      card_fields: ['ok', 7, ''],
    });
    expect(c.tipo_padrao).toBe('kanban');
    expect(c.sort).toBeNull();
    expect(c.colunas).toEqual([{ key: 'nome' }]); // width inválida some, key vazia some
    expect(c.card_fields).toEqual(['ok']);
  });

  it('width clampada em 60..640', () => {
    const c = fromSavedConfig({ colunas: [{ key: 'a', width: 10 }, { key: 'b', width: 9000 }] });
    expect(c.colunas).toEqual([{ key: 'a', width: 60 }, { key: 'b', width: 640 }]);
  });
});

describe('configIgual', () => {
  it('igualdade profunda, ordem de colunas importa', () => {
    const a = fromSavedConfig({ colunas: [{ key: 'x' }, { key: 'y' }] });
    const b = fromSavedConfig({ colunas: [{ key: 'x' }, { key: 'y' }] });
    const c = fromSavedConfig({ colunas: [{ key: 'y' }, { key: 'x' }] });
    expect(configIgual(a, b)).toBe(true);
    expect(configIgual(a, c)).toBe(false);
  });
});
