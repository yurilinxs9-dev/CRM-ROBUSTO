/**
 * Filtros do painel lateral da lista de leads — a parte que é conta pura.
 *
 * Vive aqui, e não junto do componente, porque é isto que o jest do web cobre
 * (`testRegex: 'lib/.*\.spec\.ts$'`): a serialização para query string é o
 * contrato com o backend e é onde um erro passa despercebido — filtro que some
 * não quebra a tela, só devolve a lista errada.
 */

export interface LeadPanelFilters {
  tags: string[];
  created_from: string;
  created_to: string;
  valor_min: string;
  valor_max: string;
  tarefa: '' | 'sem' | 'atrasada';
}

export const FILTROS_VAZIOS: LeadPanelFilters = {
  tags: [],
  created_from: '',
  created_to: '',
  valor_min: '',
  valor_max: '',
  tarefa: '',
};

/**
 * Vira query string para `GET /api/leads`. Campo vazio é OMITIDO — mandar
 * `valor_min=` faria o backend interpretar string vazia como número a cada
 * request, e sujaria a chave de cache da listagem com variações que significam
 * exatamente a mesma consulta.
 */
export function toQueryParams(f: LeadPanelFilters): Record<string, string> {
  const params: Record<string, string> = {};
  if (f.tags.length > 0) params.tags = f.tags.join(',');
  if (f.created_from) params.created_from = f.created_from;
  if (f.created_to) params.created_to = f.created_to;
  if (f.valor_min) params.valor_min = f.valor_min;
  if (f.valor_max) params.valor_max = f.valor_max;
  if (f.tarefa) params.tarefa = f.tarefa;
  return params;
}

/**
 * Quantos critérios estão ativos — o número na bolinha do botão "Filtros".
 * Período e valor contam UMA vez cada, mesmo com os dois campos preenchidos:
 * quem escolheu um intervalo escolheu um critério, não dois.
 */
export function contarFiltrosAtivos(f: LeadPanelFilters): number {
  let n = f.tags.length;
  if (f.created_from || f.created_to) n += 1;
  if (f.valor_min || f.valor_max) n += 1;
  if (f.tarefa) n += 1;
  return n;
}
