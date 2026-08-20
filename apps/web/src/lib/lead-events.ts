/**
 * Leitura do evento `lead:updated` do WebSocket.
 *
 * O payload carrega, além dos campos alterados, chaves de controle que não
 * pertencem ao lead. Separá-las importa por dois motivos: elas não podem ser
 * mescladas no objeto em cache, e um evento que só tem controle não tem nada
 * para aplicar — nesse caso a única forma de a tela do colega mostrar a
 * alteração é buscar de novo no servidor.
 */

/** Não são campos do lead: identificam o evento, não o conteúdo. */
const CONTROL_KEYS = new Set(['leadId', 'triggeredByUserId']);

/** Só os campos do lead que vieram no evento, sem as chaves de controle. */
export function leadUpdateFields(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (!CONTROL_KEYS.has(key)) fields[key] = value;
  }
  return fields;
}
