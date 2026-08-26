import { fetchAllByCursor, EXPORT_PAGE_SIZE } from './fetch-all-by-cursor';

/**
 * Bug original: as exportacoes CSV faziam UM findMany com `take: 10000`.
 * Tenant com mais de 10k linhas baixava arquivo incompleto e NADA avisava —
 * teto silencioso. Este helper pagina por cursor ate a pagina voltar curta.
 */

function makeRows(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({ id: `${prefix}-${i}` }));
}

describe('fetchAllByCursor', () => {
  it('pagina cheia seguida de pagina curta: concatena os dois lotes', async () => {
    const primeira = makeRows(EXPORT_PAGE_SIZE, 'a');
    const segunda = makeRows(7, 'b');
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(primeira)
      .mockResolvedValueOnce(segunda);

    const all = await fetchAllByCursor(fetchPage);

    expect(all).toHaveLength(EXPORT_PAGE_SIZE + 7);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    // 1a pagina sem cursor; 2a com cursor no ultimo id da 1a e skip:1 para
    // nao repetir a linha do cursor.
    expect(fetchPage.mock.calls[0][0]).toEqual({ take: EXPORT_PAGE_SIZE });
    expect(fetchPage.mock.calls[1][0]).toEqual({
      take: EXPORT_PAGE_SIZE,
      cursor: { id: `a-${EXPORT_PAGE_SIZE - 1}` },
      skip: 1,
    });
  });

  it('pagina unica curta: uma query so, sem segunda ida ao banco', async () => {
    const fetchPage = jest.fn().mockResolvedValueOnce(makeRows(3, 'c'));

    const all = await fetchAllByCursor(fetchPage);

    expect(all).toHaveLength(3);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('pagina exatamente cheia seguida de vazia: para na vazia, sem duplicar', async () => {
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(makeRows(EXPORT_PAGE_SIZE, 'd'))
      .mockResolvedValueOnce([]);

    const all = await fetchAllByCursor(fetchPage);

    expect(all).toHaveLength(EXPORT_PAGE_SIZE);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('teto de memoria: para no maxRows e AVISA (nunca silencioso, que era o bug)', async () => {
    const onMaxRows = jest.fn();
    const fetchPage = jest.fn().mockImplementation(() => Promise.resolve(makeRows(2, 'e')));

    const all = await fetchAllByCursor(fetchPage, { pageSize: 2, maxRows: 4, onMaxRows });

    expect(all).toHaveLength(4);
    expect(onMaxRows).toHaveBeenCalledWith(4);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('sem estourar o teto, onMaxRows nunca e chamado', async () => {
    const onMaxRows = jest.fn();
    const fetchPage = jest
      .fn()
      .mockResolvedValueOnce(makeRows(2, 'f'))
      .mockResolvedValueOnce(makeRows(1, 'g'));

    await fetchAllByCursor(fetchPage, { pageSize: 2, maxRows: 100, onMaxRows });

    expect(onMaxRows).not.toHaveBeenCalled();
  });
});
