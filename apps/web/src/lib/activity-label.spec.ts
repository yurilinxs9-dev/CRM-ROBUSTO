import { rotuloAtividade } from './activity-label';

describe('rotuloAtividade', () => {
  it('conhece os tipos gravados pelo backend', () => {
    expect(rotuloAtividade('stage_change')).toBe('Etapa alterada');
    expect(rotuloAtividade('lead_created')).toBe('Lead criado');
    expect(rotuloAtividade('lead_updated')).toBe('Lead atualizado');
    expect(rotuloAtividade('lead_merged')).toBe('Lead mesclado');
    expect(rotuloAtividade('distribution')).toBe('Lead distribuído');
    expect(rotuloAtividade('ia_temperatura')).toBe('Temperatura pela IA');
    expect(rotuloAtividade('form_resubmit')).toBe('Formulário reenviado');
    expect(rotuloAtividade('webhook')).toBe('Webhook');
    expect(rotuloAtividade('task_created')).toBe('Tarefa criada');
  });
  it('tipo desconhecido volta cru', () => {
    expect(rotuloAtividade('xpto')).toBe('xpto');
  });
});
