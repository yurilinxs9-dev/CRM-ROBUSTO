/**
 * Paginacao por cursor para leituras que precisam do conjunto COMPLETO
 * (exportacoes CSV, hoje).
 *
 * Existe porque os exports usavam um unico `findMany({ take: 10000 })`:
 * tenant acima de 10k linhas baixava arquivo incompleto e NADA avisava.
 * Aqui o loop so termina quando a pagina volta curta — ou no teto explicito
 * `maxRows`, que sempre chama `onMaxRows` (teto que nao avisa e exatamente o
 * bug que este helper mata).
 *
 * Cursor em vez de `skip` de propósito: com `skip` um insert concorrente
 * durante a exportacao desloca as paginas e faz pular/duplicar linha. Por
 * isso a query base precisa ter `id` como ultimo criterio de `orderBy`
 * (desempate unico e estavel).
 */

/** Tamanho do lote — mesmo numero do antigo `take`, agora por pagina. */
export const EXPORT_PAGE_SIZE = 10_000;

/** Teto de seguranca de memoria. Ao ser atingido, LOGA (nunca silencioso). */
export const EXPORT_MAX_ROWS = 200_000;

export interface CursorPageArgs {
  take: number;
  cursor?: { id: string };
  skip?: number;
}

export interface FetchAllByCursorOptions {
  pageSize?: number;
  maxRows?: number;
  /** Chamado quando o teto `maxRows` corta a leitura. */
  onMaxRows?: (maxRows: number) => void;
}

export async function fetchAllByCursor<T extends { id: string }>(
  fetchPage: (args: CursorPageArgs) => Promise<T[]>,
  options: FetchAllByCursorOptions = {},
): Promise<T[]> {
  const pageSize = options.pageSize ?? EXPORT_PAGE_SIZE;
  const maxRows = options.maxRows ?? EXPORT_MAX_ROWS;

  const all: T[] = [];
  let cursor: string | undefined;

  for (;;) {
    const page = await fetchPage(
      cursor === undefined
        ? { take: pageSize }
        : { take: pageSize, cursor: { id: cursor }, skip: 1 },
    );

    for (const row of page) all.push(row);

    // Pagina curta = acabou o conjunto. Unica condicao normal de parada.
    if (page.length < pageSize) break;

    if (all.length >= maxRows) {
      options.onMaxRows?.(maxRows);
      break;
    }

    cursor = page[page.length - 1].id;
  }

  return all;
}
