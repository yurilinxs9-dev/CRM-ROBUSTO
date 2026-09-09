import {
  classifyCompanyType,
  isTestRow,
  normalizePhone,
  parseCsv,
} from './sheet-import.parser';

describe('parseCsv', () => {
  it('separa colunas, respeita aspas com vírgula interna e CRLF', () => {
    const csv = 'id,nome,cidade\r\nl:1,"Silva, João",Curitiba\r\nl:2,Maria,"São José dos Pinhais"\r\n';
    expect(parseCsv(csv)).toEqual([
      { id: 'l:1', nome: 'Silva, João', cidade: 'Curitiba' },
      { id: 'l:2', nome: 'Maria', cidade: 'São José dos Pinhais' },
    ]);
  });

  it('aspas duplicadas dentro de aspas viram uma aspa', () => {
    expect(parseCsv('a,b\n"x ""y"" z",1\n')).toEqual([{ a: 'x "y" z', b: '1' }]);
  });

  it('linha vazia no fim é ignorada e coluna faltante vira string vazia', () => {
    expect(parseCsv('a,b,c\n1,2\n\n')).toEqual([{ a: '1', b: '2', c: '' }]);
  });

  it('preserva a ordem das colunas nas chaves do objeto', () => {
    const [row] = parseCsv('z,a,m\n1,2,3\n');
    expect(Object.keys(row)).toEqual(['z', 'a', 'm']);
  });
});

describe('normalizePhone', () => {
  it.each([
    ['p:+5519997094696', '5519997094696'],
    ['p:11945550754', '5511945550754'],
    ['p:+554797887666', '554797887666'],
    ['(41) 99293-8568', '5541992938568'],
    ['5541992938568', '5541992938568'],
  ])('%s -> %s', (raw, esperado) => {
    expect(normalizePhone(raw)).toBe(esperado);
  });

  it.each([['p:<test lead: dummy data for Telefone>'], [''], ['123'], ['p:+1 555 0100']])(
    'inválido %s -> null',
    (raw) => {
      expect(normalizePhone(raw)).toBeNull();
    },
  );
});

describe('classifyCompanyType', () => {
  it.each([
    ['Ltda', 'ME_LTDA'],
    ['LTDA', 'ME_LTDA'],
    ['lTDA', 'ME_LTDA'],
    ['ME', 'ME_LTDA'],
    ['Mei e LTDA', 'ME_LTDA'],
    ['Limitada', 'ME_LTDA'],
    ['Mei', 'MEI'],
    ['MEI', 'MEI'],
    ['mei', 'MEI'],
    ['Pessoa Física', 'PESSOA_FISICA'],
    ['Ainda não tenho empresa', 'PESSOA_FISICA'],
    ['Autônomo', 'PESSOA_FISICA'],
    ['Sim', 'NAO_INFORMADO'],
    ['Meu', 'NAO_INFORMADO'],
    ['Outro', 'NAO_INFORMADO'],
    ['', 'NAO_INFORMADO'],
  ])('%s -> %s', (raw, esperado) => {
    expect(classifyCompanyType(raw)).toBe(esperado);
  });
});

describe('isTestRow', () => {
  it('detecta linha de teste do Meta pelo nome, telefone ou e-mail', () => {
    expect(
      isTestRow({ 'Nome Completo': '<test lead: dummy data for Nome Completo>', Telefone: 'p:1', Email: 'x' }),
    ).toBe(true);
    expect(isTestRow({ 'Nome Completo': 'A', Telefone: 'p:<test lead: dummy data for Telefone>', Email: 'x' })).toBe(true);
    expect(isTestRow({ 'Nome Completo': 'A', Telefone: 'p:1', Email: 'test@meta.com' })).toBe(true);
  });

  it('linha real não é teste', () => {
    expect(isTestRow({ 'Nome Completo': 'Eduardo jr - Deka', Telefone: 'p:+5519997094696', Email: 'a@b.com' })).toBe(false);
  });
});
