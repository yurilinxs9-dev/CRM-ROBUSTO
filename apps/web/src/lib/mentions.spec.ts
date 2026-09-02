import { aplicarMencao, extractMentionIds, normalizeName, sugerirMencoes } from './mentions';

const users = [
  { id: 'u1', nome: 'Isamara Souza' },
  { id: 'u2', nome: 'João Pedro' },
  { id: 'u3', nome: 'Ana' },
];

describe('normalizeName', () => {
  it('minusculas e sem acento', () => {
    expect(normalizeName('João Pédro')).toBe('joao pedro');
  });
});

describe('extractMentionIds', () => {
  it('casa @primeironome e @nome completo, sem acento', () => {
    expect(extractMentionIds('oi @joao e @isamara souza', users)).toEqual(['u1', 'u2']);
  });
  it('sem @ nao casa ninguem', () => {
    expect(extractMentionIds('isamara ligou', users)).toEqual([]);
  });
});

describe('sugerirMencoes', () => {
  it('null quando nao ha @ em edicao', () => {
    expect(sugerirMencoes('cliente pediu ', users)).toBeNull();
  });
  it('lista quem comeca com o termo apos o ultimo @', () => {
    const r = sugerirMencoes('avisa @is', users);
    expect(r?.termo).toBe('is');
    expect(r?.sugestoes.map((u) => u.id)).toEqual(['u1']);
  });
  it('@ sozinho lista todos', () => {
    expect(sugerirMencoes('avisa @', users)?.sugestoes).toHaveLength(3);
  });
  it('@ seguido de espaco encerra a edicao', () => {
    expect(sugerirMencoes('avisa @isamara souza ', users)).toBeNull();
  });
});

describe('aplicarMencao', () => {
  it('troca o termo pelo nome completo e devolve o cursor depois do espaco', () => {
    const r = aplicarMencao('avisa @is', ' por favor', users[0]);
    expect(r.texto).toBe('avisa @Isamara Souza  por favor');
    expect(r.cursor).toBe('avisa @Isamara Souza '.length);
  });
});
