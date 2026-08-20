/**
 * Filtros do painel lateral da lista de leads (tags, período, valor, tarefa).
 *
 * Vivem fora de `findAll` por um motivo prático: até aqui o kanban filtrava no
 * CLIENTE, sobre os leads já baixados — e como a lista carrega paginada por
 * estágio, num pipeline de 2.400 leads o filtro respondia só sobre o pedaço
 * carregado, sem avisar que a resposta estava incompleta. Estas funções são o
 * outro lado dessa correção: o recorte passa a acontecer no banco.
 */

export type LeadWhereInput = Record<string, unknown>;

export interface PanelFilters {
  tags?: string;
  created_from?: string;
  created_to?: string;
  valor_min?: string;
  valor_max?: string;
  tarefa?: string;
  /** Um ou mais valores de LeadOrigem, separados por vírgula. */
  origem?: string;
  followup_from?: string;
  followup_to?: string;
}

/**
 * Valores aceitos em `origem`. A lista existe para NÃO repassar string crua do
 * cliente a um campo de enum: valor fora do enum faz o Prisma estourar e a
 * listagem inteira volta 500, quando o certo é ignorar o filtro sem sentido.
 */
const ORIGENS_VALIDAS = new Set([
  'WHATSAPP_INCOMING',
  'WHATSAPP_OUTGOING',
  'MANUAL',
  'IMPORT',
  'LANDING_PAGE',
  'INDICACAO',
]);

/**
 * Acrescenta uma condição ao `AND` sem pisar no que já está lá.
 *
 * `mergeSearchCondition` (lead-visibility.ts) só sabe combinar DOIS OR: o da
 * visibilidade e o da busca. Qualquer condição nova que também precise de OR —
 * o filtro de tags precisa, é "tem qualquer uma destas" — tem que entrar por
 * aqui, senão sobrescreve as anteriores e o endpoint devolve lead que o usuário
 * não deveria nem enxergar.
 */
export function pushAnd(where: LeadWhereInput, condition: unknown): void {
  const existing = where.AND;
  if (Array.isArray(existing)) existing.push(condition);
  else if (existing !== undefined && existing !== null) where.AND = [existing, condition];
  else where.AND = [condition];
}

/**
 * Recorte das abas do board: 'me' = "Meus Leads" · 'others' = "Escritório".
 *
 * Existe no servidor porque `stage_counts` sai de um `groupBy` sobre o mesmo
 * `where` da listagem — enquanto a aba era recortada só no cliente, a coluna
 * mostrava a contagem do board inteiro com um punhado de cards à vista.
 */
export type OwnerScope = 'me' | 'others';

/** Valor cru da query string → escopo válido, ou null (ignora o filtro). */
export function parseOwnerScope(raw?: string): OwnerScope | null {
  return raw === 'me' || raw === 'others' ? raw : null;
}

/**
 * Condição de "de quem é o lead" para uma das abas.
 *
 * 'others' usa OR explícito com null de propósito: `{ not: userId }` sozinho
 * deixaria de fora o lead SEM responsável, e o Escritório é justamente onde o
 * lead ainda não assumido precisa aparecer.
 */
export function ownerCondition(owner: OwnerScope, userId: string): unknown {
  return owner === 'me'
    ? { responsavel_id: userId }
    : { OR: [{ responsavel_id: null }, { responsavel_id: { not: userId } }] };
}

/**
 * Cópia do `where` com uma condição a mais no AND — ao contrário de `pushAnd`,
 * não mexe no original. É o que permite contar as DUAS abas a partir do mesmo
 * `where` base: a aba inativa precisa do total dela, não de zero.
 */
export function withCondition(where: LeadWhereInput, condition: unknown): LeadWhereInput {
  const anterior = where.AND;
  const AND = Array.isArray(anterior)
    ? [...anterior, condition]
    : anterior !== undefined && anterior !== null
      ? [anterior, condition]
      : [condition];
  return { ...where, AND };
}

/** Nomes separados por vírgula → lista limpa, sem vazios nem duplicatas. */
export function parseListaDeTags(raw: string): string[] {
  const vistos = new Set<string>();
  for (const parte of raw.split(',')) {
    const nome = parte.trim();
    if (nome) vistos.add(nome);
  }
  return [...vistos];
}

/**
 * `2026-08-07` significa "até o fim do dia 7", não "até 00:00 do dia 7". Sem
 * isto, filtrar de 01/08 a 07/08 perderia silenciosamente tudo que foi criado
 * no dia 7 — o erro clássico de intervalo de datas, e o mais difícil de notar
 * porque o resultado parece plausível.
 *
 * Só se aplica quando vem data pura (sem hora). Com hora explícita, respeita o
 * que foi pedido.
 */
export function parseDiaFinal(valor: string): Date | null {
  const apenasData = /^\d{4}-\d{2}-\d{2}$/.test(valor.trim());
  const d = new Date(apenasData ? `${valor.trim()}T23:59:59.999Z` : valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseData(valor: string): Date | null {
  const d = new Date(valor);
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseNumero(valor: string): number | null {
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

/**
 * Traduz os filtros do painel para o `where` do Prisma. Valor inválido é
 * IGNORADO em vez de virar erro: o painel manda o que o usuário digitou, e um
 * "R$" perdido no campo de valor não pode derrubar a listagem inteira.
 */
export function applyPanelFilters(where: LeadWhereInput, filters: PanelFilters): void {
  if (filters.tags) {
    const nomes = parseListaDeTags(filters.tags);
    if (nomes.length > 0) {
      // Lead.tags é jsonb (array de strings). array_contains com UM elemento é
      // "contém este"; o OR entre eles dá a semântica de "qualquer uma", que é
      // como o painel do Kommo se comporta ao marcar várias tags.
      pushAnd(where, { OR: nomes.map((nome) => ({ tags: { array_contains: [nome] } })) });
    }
  }

  const criadoEm: Record<string, Date> = {};
  if (filters.created_from) {
    const de = parseData(filters.created_from);
    if (de) criadoEm.gte = de;
  }
  if (filters.created_to) {
    const ate = parseDiaFinal(filters.created_to);
    if (ate) criadoEm.lte = ate;
  }
  if (Object.keys(criadoEm).length > 0) pushAnd(where, { created_at: criadoEm });

  const valor: Record<string, number> = {};
  if (filters.valor_min) {
    const min = parseNumero(filters.valor_min);
    if (min !== null) valor.gte = min;
  }
  if (filters.valor_max) {
    const max = parseNumero(filters.valor_max);
    if (max !== null) valor.lte = max;
  }
  if (Object.keys(valor).length > 0) pushAnd(where, { valor_estimado: valor });

  if (filters.origem) {
    const origens = parseListaDeTags(filters.origem).filter((o) => ORIGENS_VALIDAS.has(o));
    if (origens.length > 0) pushAnd(where, { origem: { in: origens } });
  }

  const followup: Record<string, Date> = {};
  if (filters.followup_from) {
    const de = parseData(filters.followup_from);
    if (de) followup.gte = de;
  }
  if (filters.followup_to) {
    const ate = parseDiaFinal(filters.followup_to);
    if (ate) followup.lte = ate;
  }
  if (Object.keys(followup).length > 0) pushAnd(where, { proximo_followup: followup });

  // 'sem': nenhuma tarefa PENDENTE — lead que ninguém agendou próximo passo.
  // 'atrasada': tem pendente com prazo já vencido.
  if (filters.tarefa === 'sem') {
    pushAnd(where, { tasks: { none: { status: 'PENDENTE' } } });
  } else if (filters.tarefa === 'atrasada') {
    pushAnd(where, {
      tasks: { some: { status: 'PENDENTE', scheduled_at: { lt: new Date() } } },
    });
  }
}
