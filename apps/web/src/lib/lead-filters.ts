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
  origem: string[];
  followup_from: string;
  followup_to: string;
}

export const FILTROS_VAZIOS: LeadPanelFilters = {
  tags: [],
  created_from: '',
  created_to: '',
  valor_min: '',
  valor_max: '',
  tarefa: '',
  origem: [],
  followup_from: '',
  followup_to: '',
};

/** Origens que o backend aceita, com o rótulo que o usuário lê. */
export const ORIGENS: ReadonlyArray<readonly [string, string]> = [
  ['WHATSAPP_INCOMING', 'WhatsApp (entrada)'],
  ['WHATSAPP_OUTGOING', 'WhatsApp (saída)'],
  ['MANUAL', 'Manual'],
  ['IMPORT', 'Importação'],
  ['LANDING_PAGE', 'Landing page'],
  ['INDICACAO', 'Indicação'],
] as const;

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
  if (f.origem.length > 0) params.origem = f.origem.join(',');
  if (f.followup_from) params.followup_from = f.followup_from;
  if (f.followup_to) params.followup_to = f.followup_to;
  return params;
}

/**
 * Quantos critérios estão ativos — o número na bolinha do botão "Filtros".
 * Período e valor contam UMA vez cada, mesmo com os dois campos preenchidos:
 * quem escolheu um intervalo escolheu um critério, não dois.
 */
export function contarFiltrosAtivos(f: LeadPanelFilters): number {
  let n = f.tags.length + f.origem.length;
  if (f.created_from || f.created_to) n += 1;
  if (f.valor_min || f.valor_max) n += 1;
  if (f.tarefa) n += 1;
  if (f.followup_from || f.followup_to) n += 1;
  return n;
}

/**
 * Hidrata um filtro salvo (coluna Json de LeadView) no formato do painel.
 *
 * O que vem do banco é Json solto — gravado por uma versão anterior do painel,
 * ou por um cliente que mandou o que quis. Cada campo é conferido contra o tipo
 * esperado e cai no vazio quando não bate: uma view antiga, salva antes de um
 * critério existir, tem que abrir normalmente em vez de derrubar a tela.
 */
export function fromSaved(bruto: unknown): LeadPanelFilters {
  if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return { ...FILTROS_VAZIOS };
  const o = bruto as Record<string, unknown>;

  const lista = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : [];
  const texto = (v: unknown): string => (typeof v === 'string' ? v : '');

  const tarefa = texto(o.tarefa);
  return {
    tags: lista(o.tags),
    created_from: texto(o.created_from),
    created_to: texto(o.created_to),
    valor_min: texto(o.valor_min),
    valor_max: texto(o.valor_max),
    tarefa: tarefa === 'sem' || tarefa === 'atrasada' ? tarefa : '',
    origem: lista(o.origem),
    followup_from: texto(o.followup_from),
    followup_to: texto(o.followup_to),
  };
}
