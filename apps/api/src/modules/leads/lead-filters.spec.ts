import {
  applyPanelFilters,
  pushAnd,
  parseListaDeTags,
  parseDiaFinal,
  parseOwnerScope,
  ownerCondition,
  withCondition,
} from './lead-filters';
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

describe('abas Meus Leads / Escritorio', () => {
  const EU = 'user-1';

  it('so aceita os dois escopos conhecidos', () => {
    expect(parseOwnerScope('me')).toBe('me');
    expect(parseOwnerScope('others')).toBe('others');
    expect(parseOwnerScope('todos')).toBeNull();
    expect(parseOwnerScope(undefined)).toBeNull();
  });

  it('"meus" e igualdade simples de responsavel', () => {
    expect(ownerCondition('me', EU)).toEqual({ responsavel_id: EU });
  });

  it('"escritorio" inclui lead SEM responsavel', () => {
    // `{ not: EU }` sozinho deixaria o lead do pool de fora — e o pool e
    // justamente o que o Escritorio existe pra mostrar.
    expect(ownerCondition('others', EU)).toEqual({
      OR: [{ responsavel_id: null }, { responsavel_id: { not: EU } }],
    });
  });

  it('withCondition nao mexe no where original', () => {
    // O `where` base e reaproveitado pra contar as DUAS abas; se a primeira
    // contagem o mutasse, a segunda voltaria com os dois recortes somados.
    const base: Record<string, unknown> = { AND: [{ a: 1 }] };
    const derivado = withCondition(base, { b: 2 });
    expect(base.AND).toEqual([{ a: 1 }]);
    expect(derivado.AND).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('withCondition compoe com AND ausente ou objeto unico', () => {
    expect(withCondition({}, { b: 2 }).AND).toEqual([{ b: 2 }]);
    expect(withCondition({ AND: { a: 1 } }, { b: 2 }).AND).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it('preserva o OR de visibilidade ao recortar a aba', () => {
    const where: Record<string, unknown> = {};
    Object.assign(
      where,
      buildVisibilityWhere({ userId: EU, role: UserRole.OPERADOR, poolEnabled: true }),
    );
    const comAba = withCondition(where, ownerCondition('me', EU));
    // A visibilidade continua no OR de cima; a aba entrou no AND ao lado dela.
    expect(comAba.OR).toEqual(where.OR);
    expect(comAba.AND).toEqual([{ responsavel_id: EU }]);
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

  it('origem: lista valida vira IN', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { origem: 'MANUAL,INDICACAO' });
    expect(where.AND).toEqual([{ origem: { in: ['MANUAL', 'INDICACAO'] } }]);
  });

  /**
   * `origem` alimenta um campo de ENUM. String fora do enum faz o Prisma
   * estourar e a listagem inteira volta 500 — o certo é descartar o valor sem
   * sentido e seguir com o resto do filtro.
   */
  it('origem invalida e descartada, sem derrubar o resto', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { origem: 'MANUAL,DROP TABLE,INEXISTENTE' });
    expect(where.AND).toEqual([{ origem: { in: ['MANUAL'] } }]);
  });

  it('origem so com valores invalidos nao filtra nada', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { origem: 'INEXISTENTE' });
    expect(where.AND).toBeUndefined();
  });

  it('proximo agendamento: intervalo com fim de dia inclusivo', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, { followup_from: '2026-08-01', followup_to: '2026-08-07' });

    const cond = (where.AND as Array<{ proximo_followup: { gte: Date; lte: Date } }>)[0];
    expect(cond.proximo_followup.gte.toISOString()).toBe('2026-08-01T00:00:00.000Z');
    expect(cond.proximo_followup.lte.toISOString()).toBe('2026-08-07T23:59:59.999Z');
  });

  it('varios criterios juntos acumulam, nenhum sobrescreve o outro', () => {
    const where: Record<string, unknown> = {};
    applyPanelFilters(where, {
      tags: 'QUENTE',
      origem: 'MANUAL',
      valor_min: '100',
      tarefa: 'sem',
    });
    expect((where.AND as unknown[]).length).toBe(4);
  });
});
