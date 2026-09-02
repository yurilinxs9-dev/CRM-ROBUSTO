import { rotuloAtividade } from './activity-label';

describe('rotuloAtividade', () => {
  it('conhece os tipos gravados pelo backend', () => {
    expect(rotuloAtividade('stage_change')).toBe('Etapa alterada');
    expect(rotuloAtividade('lead_created')).toBe('Lead criado');
    expect(rotuloAtividade('lead_updated')).toBe('Lead atualizado');
    expect(rotuloAtividade('lead_merged')).toBe('Lead mesclado');
    expect(rotuloAtividade('ia_temperatura')).toBe('Temperatura pela IA');
    expect(rotuloAtividade('REASSIGNED')).toBe('Lead transferido');
    expect(rotuloAtividade('MOVED_TO_SECTOR')).toBe('Movido para setor');
    expect(rotuloAtividade('RETURNED_TO_POOL')).toBe('Devolvido ao escritório');
    expect(rotuloAtividade('api_contact_created')).toBe('Contato criado pela API');
    expect(rotuloAtividade('api_status_changed')).toBe('Status alterado pela API');
    expect(rotuloAtividade('api_note')).toBe('Nota pela API');
    expect(rotuloAtividade('form_resubmit')).toBe('Formulário reenviado');
    expect(rotuloAtividade('task_created')).toBe('Tarefa criada');
  });
  it('tipo desconhecido volta cru', () => {
    expect(rotuloAtividade('xpto')).toBe('xpto');
  });
  it('tipos que nenhum produtor grava voltam crus', () => {
    // 'distribution' e tipo de Notification, nao de LeadActivity; 'webhook' nao existe.
    expect(rotuloAtividade('distribution')).toBe('distribution');
    expect(rotuloAtividade('webhook')).toBe('webhook');
  });
});
