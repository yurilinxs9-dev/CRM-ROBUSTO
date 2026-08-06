import {
  FIELD_TYPES,
  FIELD_SCOPES,
  NATIVE_FIELDS,
  findNative,
  coerceValue,
  FieldValueError,
  type FieldType,
} from './field-schema';

describe('NATIVE_FIELDS', () => {
  it('cobre os três escopos', () => {
    expect(Object.keys(NATIVE_FIELDS).sort()).toEqual([...FIELD_SCOPES].sort());
  });

  it('não repete native_key dentro de um escopo', () => {
    for (const escopo of FIELD_SCOPES) {
      const keys = NATIVE_FIELDS[escopo].map((f) => f.native_key);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('usa ordem única e sequencial por escopo', () => {
    for (const escopo of FIELD_SCOPES) {
      const ordens = NATIVE_FIELDS[escopo].map((f) => f.ordem);
      expect(ordens).toEqual([...ordens].sort((a, b) => a - b));
      expect(new Set(ordens).size).toBe(ordens.length);
    }
  });

  it('só usa tipos que existem em FIELD_TYPES', () => {
    for (const escopo of FIELD_SCOPES) {
      for (const f of NATIVE_FIELDS[escopo]) {
        expect(FIELD_TYPES).toContain(f.tipo);
      }
    }
  });

  it('todo campo select nativo traz options', () => {
    for (const escopo of FIELD_SCOPES) {
      for (const f of NATIVE_FIELDS[escopo]) {
        if (f.tipo === 'select' || f.tipo === 'multiselect') {
          expect(f.options?.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('DISCRIMINANTE: protege os campos de infraestrutura do lead', () => {
    // Esconder qualquer um destes quebra envio de WhatsApp, dedupe ou funil.
    const protegidos = NATIVE_FIELDS.LEAD.filter((f) => !f.removable).map((f) => f.native_key);
    expect(protegidos.sort()).toEqual(['nome', 'telefone', 'temperatura']);
  });

  it('proximo_followup é somente-API (quem escreve é o BroadcastDispatcher)', () => {
    const f = findNative('LEAD', 'proximo_followup');
    expect(f?.api_only).toBe(true);
  });

  it('contato e empresa têm o nome como campo não-removível', () => {
    expect(findNative('CONTATO', 'nome')?.removable).toBe(false);
    expect(findNative('EMPRESA', 'nome')?.removable).toBe(false);
  });

  it('findNative devolve undefined para chave customizada', () => {
    expect(findNative('LEAD', 'plano_de_interesse')).toBeUndefined();
  });
});

describe('coerceValue — vazio', () => {
  it.each(FIELD_TYPES)('trata null/undefined/"" como null no tipo %s', (tipo) => {
    expect(coerceValue(tipo, null)).toBeNull();
    expect(coerceValue(tipo, undefined)).toBeNull();
    expect(coerceValue(tipo, '')).toBeNull();
  });
});

describe('coerceValue — texto', () => {
  it('aceita string em text e textarea', () => {
    expect(coerceValue('text', 'Adman')).toBe('Adman');
    expect(coerceValue('textarea', 'Rua A, 123\nCentro')).toBe('Rua A, 123\nCentro');
  });

  it('recusa número onde espera texto', () => {
    expect(() => coerceValue('text', 42)).toThrow(FieldValueError);
  });
});

describe('coerceValue — number', () => {
  it('converte string numérica', () => {
    expect(coerceValue('number', '10')).toBe(10);
    expect(coerceValue('number', 10)).toBe(10);
    expect(coerceValue('number', '-3.5')).toBe(-3.5);
  });

  it('recusa texto não numérico e NaN', () => {
    expect(() => coerceValue('number', 'dez')).toThrow(FieldValueError);
    expect(() => coerceValue('number', Number.NaN)).toThrow(FieldValueError);
  });
});

describe('coerceValue — currency', () => {
  it('DISCRIMINANTE: lê o formato brasileiro com milhar e decimal', () => {
    expect(coerceValue('currency', '1.234,56')).toBe(1234.56);
    expect(coerceValue('currency', '12.345.678,90')).toBe(12345678.9);
  });

  it('lê vírgula sozinha como decimal', () => {
    expect(coerceValue('currency', '1234,56')).toBe(1234.56);
  });

  it('lê ponto sozinho como decimal (formato do input number)', () => {
    expect(coerceValue('currency', '1234.56')).toBe(1234.56);
  });

  it('aceita número puro', () => {
    expect(coerceValue('currency', 99.9)).toBe(99.9);
  });

  it('recusa lixo', () => {
    expect(() => coerceValue('currency', 'R$ abc')).toThrow(FieldValueError);
    expect(() => coerceValue('currency', Number.POSITIVE_INFINITY)).toThrow(FieldValueError);
  });
});

describe('coerceValue — date', () => {
  it('preserva o formato que a UI manda, sem converter', () => {
    // Converter pra ISO completo mudaria o significado dos valores já gravados.
    expect(coerceValue('date', '2026-08-05')).toBe('2026-08-05');
  });

  it('recusa data inválida', () => {
    expect(() => coerceValue('date', 'ontem')).toThrow(FieldValueError);
  });
});

describe('coerceValue — select e multiselect', () => {
  const opts = ['Instagram', 'Indicação', 'Site'];

  it('aceita opção válida', () => {
    expect(coerceValue('select', 'Site', opts)).toBe('Site');
  });

  it('recusa valor fora das opções', () => {
    expect(() => coerceValue('select', 'TikTok', opts)).toThrow(FieldValueError);
  });

  it('sem options declaradas, aceita qualquer string', () => {
    expect(coerceValue('select', 'QualquerCoisa')).toBe('QualquerCoisa');
  });

  it('multiselect devolve lista e remove repetidos preservando a ordem', () => {
    expect(coerceValue('multiselect', ['Site', 'Instagram', 'Site'], opts)).toEqual([
      'Site',
      'Instagram',
    ]);
  });

  it('multiselect recusa não-array e opção inválida', () => {
    expect(() => coerceValue('multiselect', 'Site', opts)).toThrow(FieldValueError);
    expect(() => coerceValue('multiselect', ['TikTok'], opts)).toThrow(FieldValueError);
  });
});

describe('coerceValue — boolean', () => {
  it('aceita booleano puro e as strings true/false', () => {
    expect(coerceValue('boolean', true)).toBe(true);
    expect(coerceValue('boolean', false)).toBe(false);
    expect(coerceValue('boolean', 'true')).toBe(true);
    expect(coerceValue('boolean', 'False')).toBe(false);
  });

  it('recusa sim/não e número', () => {
    expect(() => coerceValue('boolean', 'sim')).toThrow(FieldValueError);
    expect(() => coerceValue('boolean', 1)).toThrow(FieldValueError);
  });
});

describe('coerceValue — url', () => {
  it('aceita http e https', () => {
    expect(coerceValue('url', 'https://exemplo.com.br/a?b=1')).toBe('https://exemplo.com.br/a?b=1');
  });

  it('DISCRIMINANTE: recusa javascript: e outros protocolos', () => {
    expect(() => coerceValue('url', 'javascript:alert(1)')).toThrow(FieldValueError);
    expect(() => coerceValue('url', 'ftp://x.com')).toThrow(FieldValueError);
  });

  it('recusa string sem protocolo', () => {
    expect(() => coerceValue('url', 'exemplo.com.br')).toThrow(FieldValueError);
  });
});

describe('coerceValue — phone', () => {
  it('preserva a formatação recebida, sem normalizar', () => {
    // Normalizar aqui brigaria com a normalização do ingest do WhatsApp.
    expect(coerceValue('phone', '+55 (31) 99999-9999')).toBe('+55 (31) 99999-9999');
    expect(coerceValue('phone', '5583996199950')).toBe('5583996199950');
  });

  it('recusa curto demais, longo demais e com letra', () => {
    expect(() => coerceValue('phone', '123')).toThrow(FieldValueError);
    expect(() => coerceValue('phone', '1'.repeat(16))).toThrow(FieldValueError);
    expect(() => coerceValue('phone', '31 9999-ABCD')).toThrow(FieldValueError);
  });
});

describe('coerceValue — email', () => {
  it('aceita e-mail válido e apara espaços', () => {
    expect(coerceValue('email', '  admanjuazeirinho1965@gmail.com ')).toBe(
      'admanjuazeirinho1965@gmail.com',
    );
  });

  it('recusa sem arroba, sem domínio e com espaço no meio', () => {
    expect(() => coerceValue('email', 'admanjuazeirinho')).toThrow(FieldValueError);
    expect(() => coerceValue('email', 'a@b')).toThrow(FieldValueError);
    expect(() => coerceValue('email', 'a b@c.com')).toThrow(FieldValueError);
  });
});

describe('coerceValue — tipo desconhecido', () => {
  it('lança em vez de deixar passar', () => {
    expect(() => coerceValue('inexistente' as FieldType, 'x')).toThrow(FieldValueError);
  });
});
