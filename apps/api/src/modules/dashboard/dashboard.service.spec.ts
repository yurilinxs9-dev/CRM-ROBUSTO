import { Prisma } from '@prisma/client';
import { DashboardService } from './dashboard.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Previsao financeira do dashboard. Tres coisas podem sair erradas aqui e todas
 * chegam na tela como numero plausivel — o pior tipo de bug de relatorio:
 *
 * 1. Etapa de ganho/perda entrando na previsao. Ganho ja e receita, perdido vale
 *    zero; somar qualquer um dos dois infla o "previsto" do mes.
 * 2. Mes-calendario contado em UTC. Um ganho a meia-noite e meia de Sao Paulo do
 *    dia 1o ainda e dia anterior em UTC — o mes novo comecaria devendo.
 * 3. Decimal do Prisma vazando cru. `valor_estimado` nao soma sozinho e serializa
 *    como objeto: a soma vira NaN ou a tela mostra `{"s":1,"e":3,...}`.
 */

const TENANT = 'tenant-1';

const user: AuthUser = {
  id: 'u1',
  nome: 'Operador',
  email: 'o@x.com',
  role: UserRole.OPERADOR as never,
  ativo: true,
  tenantId: TENANT,
};

interface StageFixture {
  id: string;
  nome: string;
  cor: string;
  ordem: number;
  is_won: boolean;
  is_lost: boolean;
  probabilidade: number | null;
}

function etapa(over: Partial<StageFixture> & { id: string; ordem: number }): StageFixture {
  return {
    nome: over.id,
    cor: '#3498DB',
    is_won: false,
    is_lost: false,
    probabilidade: null,
    ...over,
  };
}

/** 3 abertas + 1 ganho + 1 perdido: o recorte que o por_etapa tem que fazer. */
const ETAPAS_PADRAO: StageFixture[] = [
  etapa({ id: 's-novo', ordem: 0 }),
  etapa({ id: 's-proposta', ordem: 1 }),
  etapa({ id: 's-nego', ordem: 2 }),
  etapa({ id: 's-ganho', ordem: 3, is_won: true }),
  etapa({ id: 's-perdido', ordem: 4, is_lost: true }),
];

interface GroupRow {
  estagio_id: string;
  _count: { id: number };
  _sum: { valor_estimado: Prisma.Decimal | null };
}

function grupo(estagio_id: string, count: number, total: string | null): GroupRow {
  return {
    estagio_id,
    _count: { id: count },
    _sum: { valor_estimado: total === null ? null : new Prisma.Decimal(total) },
  };
}

interface MontarOpts {
  stages?: StageFixture[];
  pipeline?: unknown;
  grupos?: GroupRow[];
  ganhoAtual?: { soma: string | null; quantidade: number };
  ganhoAnterior?: { soma: string | null; quantidade: number };
  top?: Array<Record<string, unknown>>;
}

function montar(opts: MontarOpts = {}) {
  const stages = opts.stages ?? ETAPAS_PADRAO;
  const pipeline =
    opts.pipeline === undefined ? { id: 'p-ativo', nome: 'Comercial', stages } : opts.pipeline;
  const atual = opts.ganhoAtual ?? { soma: null, quantidade: 0 };
  const anterior = opts.ganhoAnterior ?? { soma: null, quantidade: 0 };
  let chamadasAggregate = 0;

  const prisma = {
    pipeline: { findFirst: jest.fn().mockResolvedValue(pipeline) },
    lead: {
      groupBy: jest.fn().mockResolvedValue(opts.grupos ?? []),
      aggregate: jest.fn().mockImplementation(() => {
        // As duas janelas sao [inicio, fim); o que separa uma da outra e a
        // ORDEM da chamada — o mes corrente primeiro, como o service documenta.
        const alvo = chamadasAggregate++ === 0 ? atual : anterior;
        return Promise.resolve({
          _sum: { valor_estimado: alvo.soma === null ? null : new Prisma.Decimal(alvo.soma) },
          _count: { id: alvo.quantidade },
        });
      }),
      findMany: jest.fn().mockResolvedValue(opts.top ?? []),
    },
  };

  const cache = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
  };

  return {
    service: new DashboardService(prisma as never, cache as never),
    prisma,
    cache,
  };
}

describe('DashboardService.getFinanceira', () => {
  describe('previsao por etapa', () => {
    it('deixa etapa de ganho e de perda fora do por_etapa', async () => {
      const { service } = montar({
        grupos: [
          grupo('s-novo', 2, '1000'),
          grupo('s-ganho', 5, '9000'),
          grupo('s-perdido', 3, '4000'),
        ],
      });

      const r = await service.getFinanceira(user);

      expect(r.previsao.por_etapa.map((e) => e.stage.id)).toEqual([
        's-novo',
        's-proposta',
        's-nego',
      ]);
      // Ganho e perdido nao entram nem no total previsto.
      expect(r.previsao.total_aberto).toBe(1000);
    });

    it('sem probabilidade explicita, distribui por posicao entre as abertas', async () => {
      const { service } = montar();

      const r = await service.getFinanceira(user);

      expect(r.previsao.por_etapa.map((e) => e.probabilidade)).toEqual([25, 50, 75]);
    });

    it('uma unica etapa aberta fica em 50', async () => {
      const { service } = montar({
        stages: [etapa({ id: 's-unica', ordem: 0 }), etapa({ id: 's-ganho', ordem: 1, is_won: true })],
      });

      const r = await service.getFinanceira(user);

      expect(r.previsao.por_etapa.map((e) => e.probabilidade)).toEqual([50]);
    });

    it('probabilidade explicita da etapa manda; as outras seguem a posicao', async () => {
      const { service } = montar({
        stages: [
          etapa({ id: 's-novo', ordem: 0 }),
          etapa({ id: 's-proposta', ordem: 1, probabilidade: 40 }),
          etapa({ id: 's-nego', ordem: 2 }),
          etapa({ id: 's-ganho', ordem: 3, is_won: true }),
          etapa({ id: 's-perdido', ordem: 4, is_lost: true }),
        ],
      });

      const r = await service.getFinanceira(user);

      expect(r.previsao.por_etapa.map((e) => e.probabilidade)).toEqual([25, 40, 75]);
    });

    /** `probabilidade: 0` e uma escolha do gestor, nao "sem valor". */
    it('probabilidade zero nao cai no default por posicao', async () => {
      const { service } = montar({
        stages: [
          etapa({ id: 's-novo', ordem: 0, probabilidade: 0 }),
          etapa({ id: 's-proposta', ordem: 1 }),
        ],
      });

      const r = await service.getFinanceira(user);

      // A segunda continua no default da posicao (2a de 2 abertas): 67.
      expect(r.previsao.por_etapa.map((e) => e.probabilidade)).toEqual([0, 67]);
    });
  });

  describe('ponderado', () => {
    it('soma valor * probabilidade / 100 com o Decimal virado numero', async () => {
      const { service } = montar({
        stages: [
          etapa({ id: 's-novo', ordem: 0, probabilidade: 40 }),
          etapa({ id: 's-proposta', ordem: 1, probabilidade: 80 }),
        ],
        grupos: [grupo('s-novo', 2, '1000.50'), grupo('s-proposta', 1, '500')],
      });

      const r = await service.getFinanceira(user);

      expect(r.previsao.total_aberto).toBe(1500.5);
      expect(r.previsao.por_etapa[0]).toEqual({
        stage: { id: 's-novo', nome: 's-novo', cor: '#3498DB', ordem: 0 },
        count: 2,
        total: 1000.5,
        probabilidade: 40,
        ponderado: 400.2,
      });
      expect(r.previsao.ponderado).toBe(800.2);
    });

    /**
     * Somar float sem arredondar solta digito: `0.1 + 0.1 + 1000.2` da
     * 1000.4000000000001, e os ponderados dessa mesma cesta dao
     * 400.15999999999997 — os dois chegariam crus na tela como "R$ 1000,4000000000001".
     */
    it('as somas saem em centavos, sem sujeira de ponto flutuante', async () => {
      const { service } = montar({
        stages: [
          etapa({ id: 's-a', ordem: 0, probabilidade: 40 }),
          etapa({ id: 's-b', ordem: 1, probabilidade: 40 }),
          etapa({ id: 's-c', ordem: 2, probabilidade: 40 }),
        ],
        grupos: [grupo('s-a', 1, '0.10'), grupo('s-b', 1, '0.10'), grupo('s-c', 1, '1000.20')],
      });

      const r = await service.getFinanceira(user);

      expect(r.previsao.total_aberto).toBe(1000.4);
      expect(r.previsao.ponderado).toBe(400.16);
    });

    it('etapa sem lead nenhum entra zerada em vez de sumir', async () => {
      const { service } = montar({ grupos: [] });

      const r = await service.getFinanceira(user);

      expect(r.previsao.por_etapa).toHaveLength(3);
      expect(r.previsao.por_etapa[0].count).toBe(0);
      expect(r.previsao.por_etapa[0].total).toBe(0);
      expect(r.previsao.ponderado).toBe(0);
    });
  });

  describe('ganhos do mes (fuso de Sao Paulo)', () => {
    afterEach(() => jest.useRealTimers());

    function janelas(prisma: { lead: { aggregate: jest.Mock } }) {
      return prisma.lead.aggregate.mock.calls.map(
        (c: unknown[]) => (c[0] as { where: { estagio_entered_at: { gte: Date; lt?: Date } } }).where
          .estagio_entered_at,
      );
    }

    it('ganho a meia-noite e meia do dia 1o em SP conta no mes NOVO', async () => {
      // 00:30 de 1o/marco em Sao Paulo — ainda 28/fev em UTC-0 seria o mes velho.
      jest.useFakeTimers().setSystemTime(new Date('2026-03-01T03:30:00Z'));
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const [atual, anterior] = janelas(prisma);
      expect(atual.gte.toISOString()).toBe('2026-03-01T03:00:00.000Z');
      expect(anterior.gte.toISOString()).toBe('2026-02-01T03:00:00.000Z');
      expect(anterior.lt?.toISOString()).toBe('2026-03-01T03:00:00.000Z');
    });

    /**
     * O mes corrente tambem fecha em cima: data futura (correcao na mao, fila
     * com relogio adiantado) nao pode ser contada como ganho de hoje.
     */
    it('a janela do mes corrente tem teto no inicio do mes seguinte', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-03-15T12:00:00Z'));
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const [atual] = janelas(prisma);
      expect(atual.lt?.toISOString()).toBe('2026-04-01T03:00:00.000Z');
    });

    it('em dezembro o teto do mes corrente e janeiro do ano seguinte', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-12-20T12:00:00Z'));
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const [atual] = janelas(prisma);
      expect(atual.gte.toISOString()).toBe('2026-12-01T03:00:00.000Z');
      expect(atual.lt?.toISOString()).toBe('2027-01-01T03:00:00.000Z');
    });

    it('as 23h30 do dia 31 em SP o mes corrente ainda e o velho', async () => {
      // 23:30 de 31/marco em Sao Paulo = 1o/abril 02:30 UTC.
      jest.useFakeTimers().setSystemTime(new Date('2026-04-01T02:30:00Z'));
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const [atual, anterior] = janelas(prisma);
      expect(atual.gte.toISOString()).toBe('2026-03-01T03:00:00.000Z');
      expect(anterior.gte.toISOString()).toBe('2026-02-01T03:00:00.000Z');
    });

    it('em janeiro o mes anterior e dezembro do ano passado', async () => {
      jest.useFakeTimers().setSystemTime(new Date('2026-01-10T12:00:00Z'));
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const [, anterior] = janelas(prisma);
      expect(anterior.gte.toISOString()).toBe('2025-12-01T03:00:00.000Z');
    });

    it('conta so quem esta numa etapa de ganho do pipeline', async () => {
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const where = prisma.lead.aggregate.mock.calls[0][0].where as {
        tenant_id: string;
        estagio_id: { in: string[] };
      };
      expect(where.tenant_id).toBe(TENANT);
      expect(where.estagio_id.in).toEqual(['s-ganho']);
    });

    it('soma, quantidade e ticket medio saem como numero', async () => {
      const { service } = montar({
        ganhoAtual: { soma: '3000.60', quantidade: 3 },
        ganhoAnterior: { soma: '1200', quantidade: 2 },
      });

      const r = await service.getFinanceira(user);

      expect(r.ganhos).toEqual({
        mes_atual: 3000.6,
        mes_anterior: 1200,
        quantidade_mes: 3,
        ticket_medio: 1000.2,
      });
    });

    it('mes sem nenhum ganho da ticket medio 0, nunca NaN', async () => {
      const { service } = montar();

      const r = await service.getFinanceira(user);

      expect(r.ganhos).toEqual({
        mes_atual: 0,
        mes_anterior: 0,
        quantidade_mes: 0,
        ticket_medio: 0,
      });
      expect(Number.isNaN(r.ganhos.ticket_medio)).toBe(false);
    });
  });

  describe('top oportunidades', () => {
    it('pede as 5 maiores das etapas abertas, ignorando valor nulo', async () => {
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const args = prisma.lead.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
        orderBy: Record<string, string>;
        take: number;
      };
      expect(args.where).toMatchObject({
        tenant_id: TENANT,
        estagio_id: { in: ['s-novo', 's-proposta', 's-nego'] },
        valor_estimado: { not: null },
      });
      expect(args.orderBy).toEqual({ valor_estimado: 'desc' });
      expect(args.take).toBe(5);
    });

    /**
     * Lead privado so aparece pra quem e o responsavel (regra do
     * `lead-visibility`). Como a resposta e cacheada por tenant, e nao por
     * usuario, um privado de valor alto no top vazaria nome e valor pro time
     * inteiro — o corte tem que estar na CONSULTA: privado fica fora pra todos.
     */
    it('nao pede lead privado, nem o de maior valor', async () => {
      const { service, prisma } = montar();

      await service.getFinanceira(user);

      const where = prisma.lead.findMany.mock.calls[0][0].where as { is_private: boolean };
      expect(where.is_private).toBe(false);
    });

    it('devolve valor como numero e o nome da etapa achatado', async () => {
      const { service } = montar({
        top: [
          {
            id: 'lead-1',
            nome: 'Cliente Caro',
            valor_estimado: new Prisma.Decimal('1500.50'),
            temperatura: 'QUENTE',
            estagio: { nome: 'Negociacao' },
          },
        ],
      });

      const r = await service.getFinanceira(user);

      expect(r.top_oportunidades).toEqual([
        {
          lead_id: 'lead-1',
          nome: 'Cliente Caro',
          valor: 1500.5,
          etapa: 'Negociacao',
          temperatura: 'QUENTE',
        },
      ]);
    });
  });

  describe('pipeline e cache', () => {
    it('sem pipeline_id usa o pipeline ativo do tenant', async () => {
      const { service, prisma, cache } = montar();

      await service.getFinanceira(user);

      expect(prisma.pipeline.findFirst.mock.calls[0][0].where).toEqual({
        ativo: true,
        tenant_id: TENANT,
      });
      expect(cache.get).toHaveBeenCalledWith(`dash:financeira:${TENANT}:active`);
    });

    it('com pipeline_id filtra por ele dentro do tenant e usa chave propria', async () => {
      const { service, prisma, cache } = montar();

      await service.getFinanceira(user, 'p-1');

      expect(prisma.pipeline.findFirst.mock.calls[0][0].where).toEqual({
        id: 'p-1',
        tenant_id: TENANT,
      });
      expect(cache.get).toHaveBeenCalledWith(`dash:financeira:${TENANT}:p-1`);
    });

    it('tenant sem pipeline devolve o esqueleto zerado, sem quebrar a tela', async () => {
      const { service, prisma } = montar({ pipeline: null });

      const r = await service.getFinanceira(user);

      expect(r).toEqual({
        previsao: { total_aberto: 0, ponderado: 0, por_etapa: [] },
        ganhos: { mes_atual: 0, mes_anterior: 0, quantidade_mes: 0, ticket_medio: 0 },
        top_oportunidades: [],
      });
      expect(prisma.lead.groupBy).not.toHaveBeenCalled();
    });

    it('resposta ja em cache nao recalcula nada', async () => {
      const { service, prisma, cache } = montar();
      const guardado = {
        previsao: { total_aberto: 7, ponderado: 7, por_etapa: [] },
        ganhos: { mes_atual: 0, mes_anterior: 0, quantidade_mes: 0, ticket_medio: 0 },
        top_oportunidades: [],
      };
      cache.get.mockResolvedValue(guardado);

      const r = await service.getFinanceira(user);

      expect(r).toEqual(guardado);
      expect(prisma.pipeline.findFirst).not.toHaveBeenCalled();
    });
  });
});
