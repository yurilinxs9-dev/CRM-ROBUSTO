/**
 * Rotulo de `LeadActivity.tipo`. A lista foi conferida em 2026-09-02 contra os
 * `leadActivity.create` reais do backend (`apps/api/src`: leads.service.ts,
 * public-api.service.ts, lead-insights.service.ts); mudou la, muda aqui.
 * Tipo desconhecido volta cru — a public API aceita `tipo` livre.
 */
const ROTULOS: Record<string, string> = {
  stage_change: 'Etapa alterada',
  lead_created: 'Lead criado',
  lead_updated: 'Lead atualizado',
  lead_merged: 'Lead mesclado',
  ia_temperatura: 'Temperatura pela IA',
  REASSIGNED: 'Lead transferido',
  MOVED_TO_SECTOR: 'Movido para setor',
  RETURNED_TO_POOL: 'Devolvido ao escritório',
  api_contact_created: 'Contato criado pela API',
  api_status_changed: 'Status alterado pela API',
  api_note: 'Nota pela API',
  form_resubmit: 'Formulário reenviado',
  task_created: 'Tarefa criada',
};

export function rotuloAtividade(tipo: string): string {
  return ROTULOS[tipo] ?? tipo;
}
