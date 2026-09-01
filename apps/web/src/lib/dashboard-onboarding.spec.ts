import { deveMostrarOnboarding } from './dashboard-onboarding';

/**
 * `totalLeads` chega RECORTADO pela visibilidade (o backend conta a carteira de
 * quem pediu). Zero para um operador quer dizer "carteira vazia", nao
 * "workspace novo" — e o convite "crie seu primeiro lead" toma a tela inteira
 * no lugar do dashboard zerado, contando ainda uma mentira sobre a loja.
 */
describe('deveMostrarOnboarding', () => {
  it('DISCRIMINANTE: operador de carteira vazia ve o dashboard, nao o convite', () => {
    expect(deveMostrarOnboarding({ totalLeads: 0, role: 'OPERADOR', focusMode: false })).toBe(
      false,
    );
  });

  it('gestor sem nenhum lead na loja ve o convite', () => {
    expect(deveMostrarOnboarding({ totalLeads: 0, role: 'GERENTE', focusMode: false })).toBe(true);
    expect(deveMostrarOnboarding({ totalLeads: 0, role: 'SUPER_ADMIN', focusMode: false })).toBe(
      true,
    );
  });

  /** Mesmo `supervisionando` do backend: foco ligado = painel da propria carteira. */
  it('gestor em modo foco cai na regra do operador', () => {
    expect(deveMostrarOnboarding({ totalLeads: 0, role: 'GERENTE', focusMode: true })).toBe(false);
  });

  it('com lead na conta ninguem ve o convite', () => {
    expect(deveMostrarOnboarding({ totalLeads: 3, role: 'GERENTE', focusMode: false })).toBe(false);
    expect(deveMostrarOnboarding({ totalLeads: 3, role: 'OPERADOR', focusMode: false })).toBe(
      false,
    );
  });

  /** Sessao ainda hidratando: sem role conhecida, nao supervisiona. */
  it('role indefinida nao ganha o convite', () => {
    expect(deveMostrarOnboarding({ totalLeads: 0, role: undefined, focusMode: false })).toBe(false);
  });
});
