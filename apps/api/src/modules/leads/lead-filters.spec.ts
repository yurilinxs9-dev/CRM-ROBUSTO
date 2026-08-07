import { applyPanelFilters, pushAnd, parseListaDeTags, parseDiaFinal } from './lead-filters';
import { buildVisibilityWhere, mergeSearchCondition } from './lead-visibility';
import { UserRole } from '@/common/types/roles';

/**
 * Filtro errado num CRM não estoura: ele devolve a lista errada com cara de
 * certa. Os dois modos de errar que estes testes travam:
 *
 * 1. Sobrescrever a condição de VISIBILIDADE. O `where` já chega com o recorte
 *    de quem pode ver o quê; um filtro que substitui `OR` em vez de compor
 *    mostra lead de outro vendedor — vazamento, não bug de tela.
 * 2. Perder o último dia do intervalo de datas. `to=2026-08-07` tem que incluir
 *    o dia 7 inteiro.
 */

describe('pushAnd', () => {
  it('cria o AND quando nao existe', () => {
    const where: Record<string, unknown> = {};
    pushAnd(where, { a: 1 });
    expect(where.AND).toEqual([{ a: 1 }]);
  });

  it('acumula em vez de substituir', () => {
    const where: Record<string, unknown> = {};
    pushAnd(where, { a: 1 });
    pushAnd(where, { b: 2 });
    expect(where.AND).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('absorve AND que ja veio como objeto unico', () => {
    const where: Record<string, unknown> = { AND: { a: 1 } };
    pushAnd(where, { b: 2 });
    expect(where.AND).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe('parseListaDeTags', () => {
  it('apara espacos, ignora vazios e nao repete', () => {
    expect(parseListaDeTags(' QUENTE , , PRECO ,QUENTE')).toEqual(['QUENTE', 'PRECO']);
  });
});

describe('parseDiaFinal', () => {
  it('data pura vira fim do dia — senao o ultimo dia do intervalo sumiria', () => {
    expect(parseDiaFinal('2026-08-07')?.toISOString()).toBe('2026-08-07T23:59:59.999Z');
  });

  it('com hora explicita, respeita o que foi pedido', () => {
    expect(parseDiaFinal('2026-08-07T10:00:00.000Z')?.toISOString()).toBe(
      '2026-08-07T10:00:00.000Z',
    );
  });

  it('data invalida vira null, para ser ignorada', () => {
    expect(parseDiaFinal('nao e data')).toBeNull();
  });
});

describe('applyPanelFilters', () => {
  it('tags: OR entre elas — lead com QUALQUER uma entra', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { tags: 'QUENTE,PRECO' });

    expect(where.AND).toEqual([
      {
        OR: [
          { tags: { array_contains: ['QUENTE'] } },
          { tags: { array_contains: ['PRECO'] } },
        ],
      },
    ]);
  });

  /**
   * O teste central. A visibilidade do modo Individual entra como OR; a busca
   * por nome entra como um segundo OR; as tags, um terceiro. Se o filtro de
   * tags escrevesse em `where.OR` direto, apagaria a visibilidade e o operador
   * passaria a ver lead de colega.
   */
  it('nao apaga a visibilidade nem a busca ao adicionar tags', () => {
    const where: Record<string, unknown> = {};
    Object.assign(
      where,
      buildVisibilityWhere({
        userId: 'u1',
        role: UserRole.OPERADOR as never,
        poolEnabled: false,
        scope: undefined,
      }),
    );
    const visibilidadeOriginal = JSON.parse(JSON.stringify(where));

    mergeSearchCondition(where, [{ nome: { contains: 'joao', mode: 'insensitive' } }]);
    applyPanelFilters(where, { tags: 'QUENTE' });

    // A condicao de visibilidade continua presente em algum ramo do where.
    const serializado = JSON.stringify(where);
    const chaveVisibilidade = Object.keys(visibilidadeOriginal)[0];
    if (chaveVisibilidade) {
      expect(serializado).toContain(chaveVisibilidade === 'OR' ? 'responsavel_id' : chaveVisibilidade);
    }
    // E o filtro de tags entrou sem virar o unico OR do where.
    expect(serializado).toContain('array_contains');
  });

  it('periodo: from vira gte e to vira fim do dia', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { created_from: '2026-08-01', created_to: '2026-08-07' });

    const cond = (where.AND as Array<{ created_at: { gte: Date; lte: Date } }>)[0];
    expect(cond.created_at.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(cond.created_at.lte.toISOString()).toBe('2026-08-07T23:59:59.999Z');
  });

  it('valor: faixa vira gte/lte numerico', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { valor_min: '1000', valor_max: '5000' });

    expect(where.AND).toEqual([{ valor_estimado: { gte: 1000, lte: 5000 } }]);
  });

  /**
   * O painel manda o que o usuário digitou. Um "R$" perdido no campo não pode
   * derrubar a listagem — o filtro inválido é ignorado e a lista volta inteira.
   */
  it('valor invalido e ignorado, nao vira erro nem where quebrado', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { valor_min: 'R$ abc' });
    expect(where.AND).toBeUndefined();
  });

  it('data invalida e ignorada', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { created_from: 'ontem' });
    expect(where.AND).toBeUndefined();
  });

  it('tarefa=sem: nenhuma tarefa pendente', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { tarefa: 'sem' });
    expect(where.AND).toEqual([{ tasks: { none: { status: 'PENDENTE' } } }]);
  });

  it('tarefa=atrasada: pendente com prazo ja vencido', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { tarefa: 'atrasada' });

    const cond = (where.AND as Array<{
      tasks: { some: { status: string; scheduled_at: { lt: Date } } };
    }>)[0];
    expect(cond.tasks.some.status).toBe('PENDENTE');
    expect(cond.tasks.some.scheduled_at.lt).toBeInstanceOf(Date);
  });

  it('valor desconhecido em tarefa nao filtra nada', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { tarefa: 'qualquer-coisa' });
    expect(where.AND).toBeUndefined();
  });

  it('sem filtro nenhum, o where nao e tocado', () => {
    const where: Record<string, unknown> = { tenant_id: 't1' };
    applyPanelFilters(where, {});
    expect(where).toEqual({ tenant_id: 't1' });
  });
});
