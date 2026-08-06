import {
  groupFields,
  readValue,
  buildPayload,
  initialValue,
  initialValues,
  flattenFields,
  schemaFromLegacy,
  isSynthetic,
  semNulos,
  type FieldDef,
  type FieldSchema,
} from './field-render';

/**
 * Estes são os únicos testes automatizados do frontend nesta feature — o runner
 * do apps/web só cobre `src/lib`. Por isso a tradução coluna <-> Json mora aqui
 * e não dentro dos componentes: é a parte onde um erro silencioso custa dado do
 * cliente (valor gravado no lugar errado, ou save inteiro derrubado por 400).
 */

function def(over: Partial<FieldDef> = {}): FieldDef {
  return {
    id: 'f1',
    nome: 'Campo',
    key: 'campo',
    tipo: 'text',
    options: null,
    ordem: 0,
    active: true,
    escopo: 'LEAD',
    group_id: 'g1',
    native_key: null,
    api_only: false,
    visible: true,
    ...over,
  };
}

const schema: FieldSchema = {
  groups: [
    { id: 'g1', nome: 'Principal', escopo: 'LEAD', ordem: 0, is_system: true },
    { id: 'g2', nome: 'Qualificação', escopo: 'LEAD', ordem: 1, is_system: false },
    { id: 'g3', nome: 'Principal', escopo: 'CONTATO', ordem: 0, is_system: true },
  ],
  fields: [
    def({ id: 'a', key: 'nome', native_key: 'nome', nome: 'Nome', ordem: 0 }),
    def({ id: 'b', key: 'plano', nome: 'Plano', ordem: 1 }),
    def({ id: 'c', key: 'oculto', nome: 'Oculto', ordem: 2, visible: false }),
    def({ id: 'd', key: 'inativo', nome: 'Inativo', ordem: 3, active: false }),
    def({ id: 'e', key: 'obs', nome: 'Obs', group_id: 'g2', ordem: 0 }),
    def({ id: 'f', key: 'cargo', escopo: 'CONTATO', group_id: 'g3', native_key: 'cargo' }),
  ],
};

describe('groupFields', () => {
  it('separa por escopo e monta as abas na ordem', () => {
    const g = groupFields(schema, 'LEAD');
    expect(g.map((x) => x.nome)).toEqual(['Principal', 'Qualificação']);
    expect(g[0].fields.map((f) => f.key)).toEqual(['nome', 'plano']);
    expect(g[1].fields.map((f) => f.key)).toEqual(['obs']);
  });

  it('DISCRIMINANTE: esconde campo invisível e campo inativo', () => {
    const chaves = flattenFields(groupFields(schema, 'LEAD')).map((f) => f.key);
    expect(chaves).not.toContain('oculto');
    expect(chaves).not.toContain('inativo');
  });

  it('mas o editor consegue ver os ocultos (para reexibir)', () => {
    const chaves = flattenFields(groupFields(schema, 'LEAD', { incluirOcultos: true })).map(
      (f) => f.key,
    );
    expect(chaves).toContain('oculto');
    // Inativo continua fora: foi removido, não escondido.
    expect(chaves).not.toContain('inativo');
  });

  it('não mistura escopos', () => {
    expect(flattenFields(groupFields(schema, 'CONTATO')).map((f) => f.key)).toEqual(['cargo']);
  });
});

describe('readValue', () => {
  const lead = {
    nome: 'Adman Jerônimo',
    dados_custom: { plano: 'Ouro' },
  };

  it('DISCRIMINANTE: nativo lê da coluna, customizado lê do Json', () => {
    expect(readValue(def({ key: 'nome', native_key: 'nome' }), lead)).toBe('Adman Jerônimo');
    expect(readValue(def({ key: 'plano' }), lead)).toBe('Ouro');
  });

  it('a key do def pode diferir da native_key (caso de colisão)', () => {
    // Bootstrap cria `nome__nativo` quando o tenant já tinha um campo `nome`.
    expect(readValue(def({ key: 'nome__nativo', native_key: 'nome' }), lead)).toBe(
      'Adman Jerônimo',
    );
  });

  it('devolve undefined sem registro e sem dados_custom', () => {
    expect(readValue(def(), null)).toBeUndefined();
    expect(readValue(def({ key: 'x' }), { nome: 'y' })).toBeUndefined();
  });
});

describe('buildPayload', () => {
  it('DISCRIMINANTE: separa coluna de Json', () => {
    const out = buildPayload(
      [def({ key: 'nome', native_key: 'nome' }), def({ key: 'plano' })],
      { nome: 'Adman', plano: 'Ouro' },
    );
    expect(out.native).toEqual({ nome: 'Adman' });
    expect(out.custom).toEqual({ plano: 'Ouro' });
  });

  it('ignora campo não tocado', () => {
    const out = buildPayload([def({ key: 'plano' })], {});
    expect(out.custom).toEqual({});
  });

  it('DISCRIMINANTE: nunca manda campo api_only', () => {
    // O badge "Apenas API" só significa alguma coisa se a UI de fato não escrever.
    const out = buildPayload(
      [def({ key: 'followup', native_key: 'proximo_followup', api_only: true })],
      { followup: '2026-09-01' },
    );
    expect(out.native).toEqual({});
  });

  it('não manda campo oculto nem inativo', () => {
    const out = buildPayload(
      [def({ key: 'a', visible: false }), def({ key: 'b', active: false })],
      { a: 'x', b: 'y' },
    );
    expect(out.custom).toEqual({});
  });

  it('customizado vazio vira null (é assim que a UI apaga um valor)', () => {
    const out = buildPayload([def({ key: 'plano' })], { plano: '' });
    expect(out.custom).toEqual({ plano: null });
  });

  it('DISCRIMINANTE: nativo obrigatório vazio é OMITIDO, não anulado', () => {
    // `nome: ''` levaria 400 do Zod (min(1)) e derrubaria o save inteiro,
    // inclusive os campos que estavam válidos.
    const out = buildPayload(
      [def({ key: 'nome', native_key: 'nome' }), def({ key: 'telefone', native_key: 'telefone' })],
      { nome: '', telefone: '' },
    );
    expect(out.native).toEqual({});
  });

  it('nativo anulável vazio vira null', () => {
    const out = buildPayload([def({ key: 'email', native_key: 'email' })], { email: '' });
    expect(out.native).toEqual({ email: null });
  });

  it('DISCRIMINANTE: valor_estimado sai como STRING com ponto', () => {
    // updateLeadSchema declara z.string() — mandar número dá 400.
    const d = [def({ key: 'valor', native_key: 'valor_estimado', tipo: 'currency' })];
    expect(buildPayload(d, { valor: '1.234,56' }).native).toEqual({ valor_estimado: '1234.56' });
    expect(buildPayload(d, { valor: '99,90' }).native).toEqual({ valor_estimado: '99.90' });
    expect(buildPayload(d, { valor: '' }).native).toEqual({ valor_estimado: null });
    expect(typeof buildPayload(d, { valor: 1234.56 }).native.valor_estimado).toBe('string');
  });

  it('moeda com lixo vira null em vez de string inválida', () => {
    const d = [def({ key: 'valor', native_key: 'valor_estimado', tipo: 'currency' })];
    expect(buildPayload(d, { valor: 'abc' }).native).toEqual({ valor_estimado: null });
  });

  it('temperatura vazia é omitida (é enum, não aceita null)', () => {
    const d = [def({ key: 'temperatura', native_key: 'temperatura', tipo: 'select' })];
    expect(buildPayload(d, { temperatura: '' }).native).toEqual({});
    expect(buildPayload(d, { temperatura: 'QUENTE' }).native).toEqual({ temperatura: 'QUENTE' });
  });
});

describe('initialValue', () => {
  it('vazio vira string vazia, multiselect vira lista, boolean vira undefined', () => {
    expect(initialValue(def({ tipo: 'text' }), {})).toBe('');
    expect(initialValue(def({ tipo: 'multiselect' }), {})).toEqual([]);
    expect(initialValue(def({ tipo: 'boolean' }), {})).toBeUndefined();
  });

  it('converte número para string (o input controlado espera string)', () => {
    expect(initialValue(def({ key: 'n', tipo: 'number' }), { dados_custom: { n: 42 } })).toBe('42');
  });

  it('preserva boolean de verdade', () => {
    expect(initialValue(def({ key: 'b', tipo: 'boolean' }), { dados_custom: { b: false } })).toBe(
      false,
    );
  });

  it('initialValues monta o mapa inteiro por key', () => {
    const vals = initialValues(
      [def({ key: 'nome', native_key: 'nome' }), def({ key: 'plano' })],
      { nome: 'Adman', dados_custom: { plano: 'Ouro' } },
    );
    expect(vals).toEqual({ nome: 'Adman', plano: 'Ouro' });
  });
});

describe('ida e volta', () => {
  it('ler e reescrever sem editar não altera nada', () => {
    const defs = [
      def({ key: 'nome', native_key: 'nome' }),
      def({ key: 'email', native_key: 'email' }),
      def({ key: 'plano' }),
    ];
    const lead = { nome: 'Adman', email: 'a@b.com', dados_custom: { plano: 'Ouro' } };
    const out = buildPayload(defs, initialValues(defs, lead));
    expect(out.native).toEqual({ nome: 'Adman', email: 'a@b.com' });
    expect(out.custom).toEqual({ plano: 'Ouro' });
  });
});

describe('schemaFromLegacy (backend antigo)', () => {
  const legado = [
    { id: 'l1', nome: 'Plano', key: 'plano', tipo: 'select' as const, options: ['Ouro'], ordem: 0, active: true },
    { id: 'l2', nome: 'Removido', key: 'removido', tipo: 'text' as const, options: null, ordem: 1, active: false },
  ];

  it('monta um grupo único de escopo LEAD', () => {
    const s = schemaFromLegacy(legado);
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0].escopo).toBe('LEAD');
    expect(s.fields.every((f) => f.escopo === 'LEAD')).toBe(true);
  });

  it('DISCRIMINANTE: só inclui nativos que o backend antigo sabe salvar', () => {
    // `empresa` e `cargo` não existem no updateLeadSchema daquela versão — se
    // aparecessem, o Zod descartaria a chave e o usuário perderia o que digitou
    // achando que salvou.
    const nativos = schemaFromLegacy([]).fields.map((f) => f.native_key);
    expect(nativos).toEqual(['nome', 'telefone', 'email', 'valor_estimado', 'temperatura']);
    expect(nativos).not.toContain('empresa');
    expect(nativos).not.toContain('cargo');
  });

  it('descarta campo inativo e mantém o ativo', () => {
    const chaves = schemaFromLegacy(legado).fields.filter((f) => !f.native_key).map((f) => f.key);
    expect(chaves).toEqual(['plano']);
  });

  it('põe os customizados depois dos nativos', () => {
    const s = schemaFromLegacy(legado);
    const plano = s.fields.find((f) => f.key === 'plano')!;
    const maiorNativo = Math.max(...s.fields.filter((f) => f.native_key).map((f) => f.ordem));
    expect(plano.ordem).toBeGreaterThan(maiorNativo);
  });

  it('nativo sintético é identificável (não existe no banco)', () => {
    const s = schemaFromLegacy(legado);
    expect(isSynthetic(s.fields.find((f) => f.key === 'nome')!)).toBe(true);
    expect(isSynthetic(s.fields.find((f) => f.key === 'plano')!)).toBe(false);
  });

  it('o schema legado atravessa groupFields e buildPayload sem tratamento especial', () => {
    const s = schemaFromLegacy(legado);
    const defs = flattenFields(groupFields(s, 'LEAD'));
    const out = buildPayload(defs, { nome: 'Adman', plano: 'Ouro', valor_estimado: '1.234,56' });
    expect(out.native).toMatchObject({ nome: 'Adman', valor_estimado: '1234.56' });
    expect(out.custom).toEqual({ plano: 'Ouro' });
  });
});

describe('semNulos (criação)', () => {
  it('DISCRIMINANTE: tira os nulos que o createLeadSchema recusa', () => {
    // Era este null que derrubava a criação inteira quando "Valor estimado"
    // ficava em branco: o campo é .optional() sem .nullable() no backend.
    expect(semNulos({ nome: 'Adman', valor_estimado: null, empresa: null })).toEqual({
      nome: 'Adman',
    });
  });

  it('preserva string vazia, zero e false — não são "ausente"', () => {
    expect(semNulos({ a: '', b: 0, c: false })).toEqual({ a: '', b: 0, c: false });
  });

  it('na criação, nenhum nativo opcional em branco vai no payload', () => {
    const defs = [
      def({ key: 'nome', native_key: 'nome' }),
      def({ key: 'email', native_key: 'email' }),
      def({ key: 'valor', native_key: 'valor_estimado', tipo: 'currency' }),
      def({ key: 'empresa', native_key: 'empresa' }),
    ];
    const { native } = buildPayload(defs, { nome: 'Adman', email: '', valor: '', empresa: '' });
    expect(semNulos(native)).toEqual({ nome: 'Adman' });
  });
});
