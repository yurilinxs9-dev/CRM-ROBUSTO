import { leadUpdateFields } from './lead-events';

describe('leadUpdateFields', () => {
  it('DISCRIMINANTE: edição pelo formulário não traz campo nenhum', () => {
    // Formato real emitido por LeadsService.update: só controle. É o caso que
    // fazia a alteração de um usuário nunca chegar na tela do outro.
    const fields = leadUpdateFields({ leadId: 'l1', triggeredByUserId: 'u1' });
    expect(Object.keys(fields)).toHaveLength(0);
  });

  it('mantém os campos do lead e descarta só o controle', () => {
    const fields = leadUpdateFields({
      leadId: 'l1',
      triggeredByUserId: 'u1',
      responsavel_id: 'u2',
      tags: ['quente'],
      temperatura: 'QUENTE',
    });
    expect(fields).toEqual({
      responsavel_id: 'u2',
      tags: ['quente'],
      temperatura: 'QUENTE',
    });
  });

  it('preserva valores falsy — null é uma alteração legítima', () => {
    // Devolver a responsabilidade emite responsavel_id: null. Tratar isso como
    // "sem campo" faria o card continuar mostrando o dono antigo.
    const fields = leadUpdateFields({ leadId: 'l1', responsavel_id: null });
    expect(fields).toEqual({ responsavel_id: null });
    expect(Object.keys(fields)).toHaveLength(1);
  });

  it('payload sem controle nenhum passa inteiro', () => {
    expect(leadUpdateFields({ ai_blocked: true })).toEqual({ ai_blocked: true });
  });
});
