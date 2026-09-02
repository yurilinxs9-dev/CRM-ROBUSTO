import { decidirCommit, formatarExibicao, normalizar } from './inline-field-state';

describe('normalizar', () => {
  it('text: trim; vazio vira null', () => {
    expect(normalizar('text', '  Ana ')).toBe('Ana');
    expect(normalizar('text', '   ')).toBeNull();
  });
  it('phone: so digitos', () => {
    expect(normalizar('phone', '(31) 9 9999-0000')).toBe('31999990000');
  });
  it('email: minusculas e trim', () => {
    expect(normalizar('email', ' Ana@X.com ')).toBe('ana@x.com');
  });
  it('currency: aceita 1.234,56 e 1234.56, devolve string decimal com ponto', () => {
    expect(normalizar('currency', '1.234,56')).toBe('1234.56');
    expect(normalizar('currency', '1234.56')).toBe('1234.56');
    expect(normalizar('currency', 'R$ 50')).toBe('50');
    expect(normalizar('currency', 'abc')).toBeNull();
  });
});

describe('decidirCommit', () => {
  it('igual ao atual ignora', () => {
    expect(decidirCommit('text', 'Ana', ' Ana ')).toEqual({ acao: 'ignorar', motivo: 'igual' });
  });
  it('email invalido ignora', () => {
    expect(decidirCommit('email', null, 'nao-e-email')).toEqual({ acao: 'ignorar', motivo: 'invalido' });
  });
  it('currency com texto ignora como invalido, vazio limpa', () => {
    expect(decidirCommit('currency', '10.00', 'abc')).toEqual({ acao: 'ignorar', motivo: 'invalido' });
    expect(decidirCommit('currency', '10.00', '')).toEqual({ acao: 'salvar', valor: null });
  });
  it('diferente salva normalizado', () => {
    expect(decidirCommit('phone', '31999990000', '(31) 98888-0000')).toEqual({ acao: 'salvar', valor: '31988880000' });
  });
});

describe('formatarExibicao', () => {
  it('currency em BRL', () => {
    expect(formatarExibicao('currency', '1234.5')).toMatch(/R\$\s?1\.234,50/);
  });
  it('select mostra o label da opcao', () => {
    expect(formatarExibicao('select', 'QUENTE', [{ value: 'QUENTE', label: 'Quente' }])).toBe('Quente');
  });
  it('null vira vazio', () => {
    expect(formatarExibicao('text', null)).toBe('');
  });
});

describe('normalizar currency: ponto como milhar', () => {
  it('sem virgula, grupos de 3 depois do ponto sao milhar', () => {
    expect(normalizar('currency', '1.500')).toBe('1500');
    expect(normalizar('currency', '1.500.000')).toBe('1500000');
  });
  it('ponto que nao forma grupos de 3 continua decimal', () => {
    expect(normalizar('currency', '1.5')).toBe('1.5');
    expect(normalizar('currency', '1234.56')).toBe('1234.56');
  });
});

describe('decidirCommit: casos extras', () => {
  it('phone nao vazio sem digito e invalido', () => {
    expect(decidirCommit('phone', null, 'abc')).toEqual({ acao: 'ignorar', motivo: 'invalido' });
  });
  it('email preenchido com rascunho vazio limpa', () => {
    expect(decidirCommit('email', 'a@b.com', '')).toEqual({ acao: 'salvar', valor: null });
  });
  it('select igual ao atual ignora', () => {
    expect(decidirCommit('select', 'QUENTE', 'QUENTE')).toEqual({ acao: 'ignorar', motivo: 'igual' });
  });
  it('texto so com espacos com atual null ignora como igual', () => {
    expect(decidirCommit('text', null, '   ')).toEqual({ acao: 'ignorar', motivo: 'igual' });
  });
});

describe('formatarExibicao phone', () => {
  it('11 digitos vira (31) 99999-0000', () => {
    expect(formatarExibicao('phone', '31999990000')).toBe('(31) 99999-0000');
  });
  it('13 digitos comecando com 55 vira +55 (31) 99999-0000', () => {
    expect(formatarExibicao('phone', '5531999990000')).toBe('+55 (31) 99999-0000');
  });
  it('outro tamanho volta cru', () => {
    expect(formatarExibicao('phone', '3199990000')).toBe('3199990000');
  });
});
