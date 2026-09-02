/** Rotulo de `LeadActivity.tipo` (tipos gravados pelo backend). */
const ROTULOS: Record<string, string> = {
  stage_change: 'Etapa alterada',
  lead_created: 'Lead criado',
  lead_updated: 'Lead atualizado',
  lead_merged: 'Lead mesclado',
  distribution: 'Lead distribuído',
  ia_temperatura: 'Temperatura pela IA',
  form_resubmit: 'Formulário reenviado',
  webhook: 'Webhook',
  task_created: 'Tarefa criada',
};

export function rotuloAtividade(tipo: string): string {
  return ROTULOS[tipo] ?? tipo;
}
