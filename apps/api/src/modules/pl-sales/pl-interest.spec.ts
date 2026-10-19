import { confirmedPlInterest } from './pl-interest';

const incoming = [{ de: 'cliente' as const, texto: 'Quero um consórcio para reformar minha casa.' }];
const proposal = { categoria: 'Reforma', detalhe: '', evidencia: 'Quero um consórcio para reformar minha casa.', confianca: 0.99 };

describe('PL asset interest from customer evidence', () => {
  it('accepts a supported category grounded in an incoming message', () => {
    expect(confirmedPlInterest(proposal, incoming)).toEqual({ bem_de_interesse: 'Reforma' });
  });
  it.each([
    { ...proposal, categoria: 'Inventado' },
    { ...proposal, confianca: 0.8 },
    { ...proposal, evidencia: 'Quero comprar um apartamento.' },
    { ...proposal, evidencia: '' },
    { ...proposal, categoria: 'Outros', detalhe: '' },
    { ...proposal, categoria: 'Outros', detalhe: 'barco' },
  ])('rejects uncertain, invalid or ungrounded output %j', (value) => {
    expect(confirmedPlInterest(value, incoming)).toBeNull();
  });
  it('does not use the salesperson words as customer evidence', () => {
    expect(confirmedPlInterest(proposal, [{ de: 'equipe', texto: proposal.evidencia }])).toBeNull();
  });
  it('keeps a free-text asset only when the customer actually mentioned it', () => {
    const texto = 'Tenho interesse em um consórcio de moto.';
    expect(confirmedPlInterest({ categoria: 'Outros', detalhe: 'moto', evidencia: texto, confianca: 0.99 }, [{ de: 'cliente', texto }]))
      .toEqual({ bem_de_interesse: 'Outros', outro_bem_de_interesse: 'moto' });
  });
});
