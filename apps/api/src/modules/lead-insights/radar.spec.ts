import { Prisma, UserRole } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AiProviderService } from '../ai/ai-provider.service';
import type { LeadsService } from '../leads/leads.service';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadInsightsService } from './lead-insights.service';
import { RadarController, radarQuerySchema } from './lead-insights.controller';
import type { GerarInsightJobData } from './lead-insights.queue';

/**
 * Radar comercial: 4 consultas ao Prisma, uma por secao. Mocks na borda, no
 * mesmo espirito do lead-insights.service.spec — o service roda de verdade e
 * as asseracoes caem tanto no `where` enviado (visibilidade, estagio ganho/
 * perdido, regra de cada fila) quanto no formato do que volta para a UI.
 *
 * O `where` importa MAIS do que o normal aqui: com o Prisma mockado, o que os
 * dados de retorno provam e so a montagem do card. Quem filtra de verdade em
 * producao e a clausula enviada — por isso as regras de negocio das filas sao
 * aferidas no `where`, nao no que o mock devolve.
 */

/**
 * O que `prisma.lead.fields.last_customer_message_at` devolve de verdade e um
 * FieldRef opaco do client. Aqui basta um sentinela: o que importa e provar que
 * o service manda ESSE objeto para dentro do `where` (a comparacao coluna-a-
 * coluna acontece no banco), e nao um valor calculado em JS.
 *
 * E o sentinela cobre um buraco real do compilador: `Prisma.LeadWhereInput`
 * aceita QUALQUER field ref de DateTime do Lead, entao trocar
 * `last_customer_message_at` por `ultima_interacao` compila liso. Como o mock
 * so define aquele campo, a troca vira `undefined` e estes testes quebram.
 */
const REF_CLIENTE = Symbol('Lead.fields.last_customer_message_at');

function montar() {
  const leadInsight = { findUnique: jest.fn(), upsert: jest.fn() };
  const message = { count: jest.fn(), findMany: jest.fn() };
  const lead = {
    findFirst: jest.fn(),
    findMany: jest.fn(),
    fields: { last_customer_message_at: REF_CLIENTE },
  };
  const tenant = { findUnique: jest.fn() };
  const prisma = { leadInsight, message, lead, tenant };
  const queue = { add: jest.fn() };
  const ai = { chat: jest.fn() };
  const leads = { findOne: jest.fn() };

  const service = new LeadInsightsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue<GerarInsightJobData>,
    ai as unknown as AiProviderService,
    leads as unknown as LeadsService,
  );
  // Modo individual por padrao (o mais restritivo).
  tenant.findUnique.mockResolvedValue({ pool_enabled: false });
  lead.findMany.mockResolvedValue([]);
  return { service, lead, tenant, prisma };
}

const DIA = 24 * 60 * 60 * 1000;
const AGORA = new Date('2026-08-25T12:00:00Z');

const operador: AuthUser = {
  id: 'u1',
  nome: 'Vendedor',
  email: 'v@x.com',
  role: UserRole.OPERADOR,
  ativo: true,
  tenantId: 't1',
};

const gerente: AuthUser = { ...operador, id: 'u9', role: UserRole.GERENTE };

interface WhereRadar {
  tenant_id?: string;
  pipeline_id?: string;
  responsavel_id?: string;
  OR?: unknown[];
  estagio?: { is_won: boolean; is_lost: boolean };
  temperatura?: { in: string[] };
  ultima_interacao?: { lte: Date };
  last_customer_message_at?: { not: null; gte: Date };
  AND?: unknown[];
  lead_insight?: { proxima_acao_at: { lte: Date } };
}
interface ArgsRadar {
  where: WhereRadar;
  orderBy: Record<string, unknown>;
  take: number;
  select: Record<string, unknown>;
}

function argsDe(lead: { findMany: jest.Mock }, i: number): ArgsRadar {
  const [args] = lead.findMany.mock.calls[i] as [ArgsRadar];
  return args;
}

/**
 * Ordem em que o service dispara as 4 consultas. `esperando_voce` e a ULTIMA
 * consulta (para nao renumerar os indices ja usados pelos testes das 3 secoes
 * antigas), mas a PRIMEIRA no dedupe — precedencia maxima.
 */
const IDX_VENCIDOS = 0;
const IDX_QUENTES = 1;
const IDX_PARADOS = 2;
const IDX_ESPERANDO = 3;
const TODAS_AS_FILAS = 4;

/** Mocka as 4 chamadas do radar na ordem em que o service as dispara. */
function mockRadar(
  lead: { findMany: jest.Mock },
  filas: { vencidos?: unknown[]; quentes?: unknown[]; parados?: unknown[]; esperando?: unknown[] },
): void {
  lead.findMany
    .mockResolvedValueOnce(filas.vencidos ?? [])
    .mockResolvedValueOnce(filas.quentes ?? [])
    .mockResolvedValueOnce(filas.parados ?? [])
    .mockResolvedValueOnce(filas.esperando ?? []);
}

function linha(over: Record<string, unknown> = {}) {
  return {
    id: 'lead-1',
    nome: 'Cliente Teste',
    telefone: '5511900000000',
    temperatura: 'QUENTE',
    ultima_interacao: new Date('2026-08-20T12:00:00Z'),
    estagio: { nome: 'Proposta' },
    // Formato cru do Prisma: relacao aninhada, nao o nome ja achatado.
    responsavel: { nome: 'Vendedor Um' },
    lead_tags: [{ tag: { nome: 'Orcamento' } }, { tag: { nome: 'VIP' } }],
    // Coluna Json legada, vazia quando a relacao existe (lead vindo da public API).
    tags: [],
    // Colunas do select: por padrao o lead nao tem mensagem de cliente pendente
    // nem valor estimado.
    last_customer_message_at: null,
    valor_estimado: null,
    lead_insight: {
      proxima_acao_at: new Date('2026-08-25T09:00:00Z'),
      proxima_acao_motivo: 'Confirmar a proposta enviada.',
      msg_sugerida: 'Oi! Conseguiu ver a proposta?',
    },
    ...over,
  };
}

/**
 * Linha como o banco a devolve para a fila esperando_voce. Nao recebe
 * `last_agent_message_at`: quem decide se o lead esta esperando e o `where`
 * (ver o teste do filtro), nao o conteudo da linha — um parametro aqui daria a
 * impressao falsa de que o service reavalia a regra.
 */
function esperandoLinha(id: string, cliente: string, over: Record<string, unknown> = {}) {
  return linha({ id, last_customer_message_at: new Date(cliente), ...over });
}

describe('LeadInsightsService.radar', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('chamar_hoje: proxima_acao_at vencida, do mais atrasado para o menos', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({
        id: 'lead-atrasado',
        nome: 'Bem Atrasado',
        lead_insight: {
          proxima_acao_at: new Date('2026-08-22T09:00:00Z'),
          proxima_acao_motivo: 'Retomar o orcamento.',
          msg_sugerida: 'Oi, tudo certo com o orcamento?',
        },
      }),
      linha({ id: 'lead-hoje' }),
    ]);

    const radar = await m.service.radar(operador);

    const args = argsDe(m.lead, 0);
    expect(args.where.lead_insight).toEqual({ proxima_acao_at: { lte: AGORA } });
    // Mais atrasado primeiro: a data mais antiga na frente.
    expect(args.orderBy).toEqual({ lead_insight: { proxima_acao_at: 'asc' } });
    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-atrasado', 'lead-hoje']);
    expect(radar.chamar_hoje[0]).toEqual({
      lead_id: 'lead-atrasado',
      nome: 'Bem Atrasado',
      telefone: '5511900000000',
      etapa: 'Proposta',
      temperatura: 'QUENTE',
      ultima_interacao: new Date('2026-08-20T12:00:00Z'),
      motivo: 'Retomar o orcamento.',
      msg_sugerida: 'Oi, tudo certo com o orcamento?',
      proxima_acao_at: new Date('2026-08-22T09:00:00Z'),
      responsavel: 'Vendedor Um',
      tags: ['Orcamento', 'VIP'],
      // So a fila esperando_voce preenche este campo.
      esperando_desde: null,
    });
  });

  it('responsavel e tags chegam achatados no card', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({
        id: 'lead-com-dono',
        responsavel: { nome: 'Maria Vendas' },
        lead_tags: [{ tag: { nome: 'Reforma' } }],
      }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].responsavel).toBe('Maria Vendas');
    expect(radar.chamar_hoje[0].tags).toEqual(['Reforma']);
  });

  it('lead sem responsavel vira null e sem tag vira lista vazia', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({ id: 'lead-orfao', responsavel: null, lead_tags: [], tags: [] }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].responsavel).toBeNull();
    expect(radar.chamar_hoje[0].tags).toEqual([]);
  });

  it('tag gravada pelo app interno (coluna Json) aparece quando a relacao esta vazia', async () => {
    // Dois estoques de tag no CRM: o app interno grava na coluna Json `tags` e a
    // public API grava na join LeadTag. Ler so a join deixaria quase todo lead do
    // app interno sem chip nenhum no radar.
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({ id: 'lead-do-app', lead_tags: [], tags: ['VIP'] }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].tags).toEqual(['VIP']);
  });

  it('com as duas fontes preenchidas, a relacao ganha do Json legado', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({ id: 'lead-dois-estoques', lead_tags: [{ tag: { nome: 'Reforma' } }], tags: ['Antiga'] }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].tags).toEqual(['Reforma']);
  });

  it('lixo na coluna Json nao vira chip (numero, null, objeto, string em branco)', async () => {
    // A coluna e Json cru: nada no banco garante que so tem string la dentro.
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({ id: 'lead-lixo', lead_tags: [], tags: ['VIP', 7, null, { nome: 'x' }, '', '  '] }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].tags).toEqual(['VIP']);
    // String em branco tambem cai fora: viraria um chip vazio na UI.
    expect(radar.chamar_hoje[0].tags).not.toContain('');
  });

  it('coluna Json nula (lead antigo) nao quebra o card', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([
      linha({ id: 'lead-velho', lead_tags: [], tags: null }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].tags).toEqual([]);
  });

  it('as 4 secoes pedem responsavel e tags ao banco', async () => {
    // O mock devolve o que quiser: sem conferir o `select`, a UI ficaria sem
    // dono e sem tag em producao com a suite verde.
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      const { select } = argsDe(m.lead, i);
      expect(select.responsavel).toEqual({ select: { nome: true } });
      expect(select.lead_tags).toEqual({
        select: { tag: { select: { nome: true } } },
        // Ordem estavel: sem isso os chips trocam de lugar entre requisicoes.
        orderBy: { tag: { nome: 'asc' } },
      });
      // As duas fontes de tag saem na mesma linha: o Json custa zero a mais.
      expect(select.tags).toBe(true);
      // `esperando_desde` e `resumo.valor_chamar_hoje` saem destas duas colunas:
      // sem elas no select os dois existiriam so no mock, com a suite verde e
      // a tela sem dado em producao.
      expect(select.last_customer_message_at).toBe(true);
      expect(select.valor_estimado).toBe(true);
    }
  });

  it('promissores: lead quente sem interacao ha 2 dias ou mais', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      linha({ id: 'lead-quente', ultima_interacao: new Date('2026-08-20T12:00:00Z') }),
    ]);

    const radar = await m.service.radar(operador);

    const args = argsDe(m.lead, 1);
    expect(args.where.temperatura).toEqual({ in: ['QUENTE', 'MUITO_QUENTE'] });
    expect(args.where.ultima_interacao).toEqual({ lte: new Date(AGORA.getTime() - 2 * DIA) });
    expect(radar.promissores.map((i) => i.lead_id)).toEqual(['lead-quente']);
  });

  it('promissores: lead que ja esta em chamar_hoje nao duplica (precedencia)', async () => {
    const m = montar();
    m.lead.findMany
      .mockResolvedValueOnce([linha({ id: 'lead-1' })])
      .mockResolvedValueOnce([linha({ id: 'lead-1' }), linha({ id: 'lead-2' })])
      .mockResolvedValueOnce([linha({ id: 'lead-1' }), linha({ id: 'lead-2' }), linha({ id: 'lead-3' })]);

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-1']);
    expect(radar.promissores.map((i) => i.lead_id)).toEqual(['lead-2']);
    expect(radar.esfriando.map((i) => i.lead_id)).toEqual(['lead-3']);
  });

  it('esfriando: sem interacao ha 7 dias ou mais', async () => {
    const m = montar();
    m.lead.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        linha({
          id: 'lead-frio',
          temperatura: 'MORNO',
          ultima_interacao: new Date('2026-08-15T12:00:00Z'),
          lead_insight: null,
        }),
      ]);

    const radar = await m.service.radar(operador);

    const args = argsDe(m.lead, 2);
    expect(args.where.ultima_interacao).toEqual({ lte: new Date(AGORA.getTime() - 7 * DIA) });
    expect(radar.esfriando).toHaveLength(1);
    // Sem ficha, o motivo e derivado do tempo parado.
    expect(radar.esfriando[0].motivo).toBe('sem contato ha 10 dias');
    expect(radar.esfriando[0].msg_sugerida).toBe('');
    expect(radar.esfriando[0].proxima_acao_at).toBeNull();
  });

  it('motivo derivado marca o lead quente quando a ficha nao tem motivo', async () => {
    const m = montar();
    m.lead.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
      linha({
        id: 'lead-quente',
        ultima_interacao: new Date('2026-08-20T12:00:00Z'),
        lead_insight: { proxima_acao_at: null, proxima_acao_motivo: '', msg_sugerida: '' },
      }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.promissores[0].motivo).toBe('QUENTE sem contato ha 5 dias');
  });

  it('estagio ganho ou perdido nunca aparece em nenhuma secao', async () => {
    const m = montar();

    await m.service.radar(operador);

    expect(m.lead.findMany).toHaveBeenCalledTimes(TODAS_AS_FILAS);
    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      expect(argsDe(m.lead, i).where.estagio).toEqual({ is_won: false, is_lost: false });
      expect(argsDe(m.lead, i).where.tenant_id).toBe('t1');
    }
  });

  it('OPERADOR em modo individual so ve os leads dele', async () => {
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      expect(argsDe(m.lead, i).where.responsavel_id).toBe('u1');
    }
  });

  it('modo compartilhado: o OR do pool sobrevive nas 4 secoes, ao lado do filtro da secao', async () => {
    // O `where` trafega como Record<string, unknown>: nada de tipo impede uma
    // secao futura de trazer o proprio `OR` e comer o da visibilidade em
    // silencio — o que vazaria lead de outro operador com a suite verde.
    const m = montar();
    m.tenant.findUnique.mockResolvedValue({ pool_enabled: true });

    await m.service.radar(operador);

    const orDoPool = [{ responsavel_id: null, is_private: false }, { responsavel_id: 'u1' }];
    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      const args = argsDe(m.lead, i);
      expect(args.where.OR).toEqual(orDoPool);
      // No pool, o vinculo e pelo OR: amarrar responsavel_id esconderia o pool.
      expect(args.where.responsavel_id).toBeUndefined();
    }
    // Filtro da secao entra como chave IRMA do OR (AND implicito do Prisma).
    expect(argsDe(m.lead, IDX_VENCIDOS).where.lead_insight).toEqual({
      proxima_acao_at: { lte: AGORA },
    });
    expect(argsDe(m.lead, IDX_QUENTES).where.ultima_interacao).toEqual({
      lte: new Date(AGORA.getTime() - 2 * DIA),
    });
    expect(argsDe(m.lead, IDX_PARADOS).where.ultima_interacao).toEqual({
      lte: new Date(AGORA.getTime() - 7 * DIA),
    });
    // A fila nova e a que corria o risco: ela PRECISA de um `OR` ("equipe nunca
    // respondeu OU respondeu antes do cliente"), e escrever esse OR no topo do
    // where comeria o OR do pool em silencio — vazando lead de outro operador
    // com a suite verde. Por isso ele vai aninhado dentro de `AND`, que e uma
    // chave que buildVisibilityWhere nunca escreve.
    const esperando = argsDe(m.lead, IDX_ESPERANDO).where;
    expect(esperando.last_customer_message_at).toEqual({
      not: null,
      gte: new Date(AGORA.getTime() - 30 * DIA),
    });
    expect(esperando.AND).toEqual([
      { OR: [{ last_agent_message_at: null }, { last_agent_message_at: { lt: REF_CLIENTE } }] },
    ]);
    // O que este teste inteiro existe para garantir: o OR do topo continua
    // sendo o do pool, e nao o da secao.
    expect(esperando.OR).toEqual(orDoPool);
  });

  it('GERENTE em modo individual nao e amarrado a responsavel_id', async () => {
    const m = montar();

    await m.service.radar(gerente);

    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      expect(argsDe(m.lead, i).where.responsavel_id).toBeUndefined();
    }
  });

  it('cap de 30 por secao', async () => {
    const m = montar();
    const muitos = Array.from({ length: 40 }, (_, i) => linha({ id: `lead-${i}` }));
    // As 4 filas devolvem os MESMOS 40 leads: o pior caso do dedupe.
    m.lead.findMany.mockResolvedValue(muitos);

    const radar = await m.service.radar(operador);

    for (let i = 0; i < TODAS_AS_FILAS; i++) expect(argsDe(m.lead, i).take).toBe(30);
    // Precedencia: esperando_voce serve primeiro e leva os 30.
    expect(radar.esperando_voce).toHaveLength(30);
    // As outras secoes recebem os mesmos ids: o dedupe come o resto.
    expect(radar.chamar_hoje).toHaveLength(10);
    expect(radar.promissores).toHaveLength(0);
    expect(radar.esfriando).toHaveLength(0);
  });
});

describe('LeadInsightsService.radar — fila esperando_voce', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('cliente falou depois da equipe: entra na fila, do que espera ha mais tempo para o menos', async () => {
    const m = montar();
    mockRadar(m.lead, {
      esperando: [
        // Ordem do banco ja e ASC por last_customer_message_at.
        esperandoLinha('lead-ontem', '2026-08-24T08:00:00Z'),
        esperandoLinha('lead-agora-pouco', '2026-08-25T11:00:00Z'),
      ],
    });

    const radar = await m.service.radar(operador);

    // A ordem quem faz e o banco (o service nao reordena), entao o que tem
    // dentes aqui e o orderBy — a lista so confirma que nada a embaralha.
    expect(argsDe(m.lead, IDX_ESPERANDO).orderBy).toEqual({ last_customer_message_at: 'asc' });
    expect(radar.esperando_voce.map((i) => i.lead_id)).toEqual(['lead-ontem', 'lead-agora-pouco']);
    // ISO, nao Date: a UI calcula "esperando ha Xh" a partir da string.
    expect(radar.esperando_voce[0].esperando_desde).toBe('2026-08-24T08:00:00.000Z');
  });

  it('a regra "equipe nao respondeu" e resolvida pelo BANCO, nao em memoria', async () => {
    // Este e o teste que vale: o `where` e o que vai para producao. Filtrar
    // depois, em memoria, sobre um lote com `take`, e furado — o lote vem
    // ordenado por quem espera ha mais tempo, que sao justamente os candidatos
    // com mais chance de JA terem sido respondidos; num tenant movimentado a
    // fila apareceria vazia com clientes esperando de verdade no banco.
    const m = montar();

    await m.service.radar(operador);

    const { where } = argsDe(m.lead, IDX_ESPERANDO);
    // Coluna simples: existe mensagem do cliente e ela e recente.
    expect(where.last_customer_message_at).toEqual({
      not: null,
      gte: new Date(AGORA.getTime() - 30 * DIA),
    });
    // Comparacao coluna-a-coluna via field reference do Prisma. `null` (equipe
    // nunca respondeu) entra explicitamente porque em SQL `null < data` e null.
    expect(where.AND).toEqual([
      {
        OR: [
          { last_agent_message_at: null },
          { last_agent_message_at: { lt: REF_CLIENTE } },
        ],
      },
    ]);
  });

  it('a fila nova pede ao banco so os 30 cards, nao um lote para filtrar depois', async () => {
    const m = montar();

    await m.service.radar(operador);

    expect(argsDe(m.lead, IDX_ESPERANDO).take).toBe(30);
  });

  it('equipe nunca respondeu (last_agent_message_at null) e um lead esperando', async () => {
    const m = montar();
    mockRadar(m.lead, {
      esperando: [esperandoLinha('lead-nunca-respondido', '2026-08-24T08:00:00Z')],
    });

    const radar = await m.service.radar(operador);

    expect(radar.esperando_voce.map((i) => i.lead_id)).toEqual(['lead-nunca-respondido']);
    expect(radar.esperando_voce[0].esperando_desde).toBe('2026-08-24T08:00:00.000Z');
  });

  it('lead sem mensagem do cliente nao ganha esperando_desde nem que o banco erre', async () => {
    const m = montar();
    mockRadar(m.lead, {
      esperando: [linha({ id: 'lead-mudo', last_customer_message_at: null })],
    });

    const radar = await m.service.radar(operador);

    expect(radar.esperando_voce[0].esperando_desde).toBeNull();
  });

  it('cap de 30 cards na fila nova', async () => {
    const m = montar();
    const muitos = Array.from({ length: 40 }, (_, i) =>
      esperandoLinha(`lead-esp-${i}`, '2026-08-24T08:00:00Z'),
    );
    mockRadar(m.lead, { esperando: muitos });

    const radar = await m.service.radar(operador);

    expect(radar.esperando_voce).toHaveLength(30);
  });

  it('precedencia maxima: quem esta esperando nao reaparece nas outras 3 secoes', async () => {
    const m = montar();
    const esperandoAgora = esperandoLinha('lead-1', '2026-08-24T08:00:00Z');
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-1' }), linha({ id: 'lead-2' })],
      quentes: [linha({ id: 'lead-1' }), linha({ id: 'lead-3' })],
      parados: [linha({ id: 'lead-1' }), linha({ id: 'lead-4' })],
      esperando: [esperandoAgora],
    });

    const radar = await m.service.radar(operador);

    expect(radar.esperando_voce.map((i) => i.lead_id)).toEqual(['lead-1']);
    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-2']);
    expect(radar.promissores.map((i) => i.lead_id)).toEqual(['lead-3']);
    expect(radar.esfriando.map((i) => i.lead_id)).toEqual(['lead-4']);
  });

  it('estagio ganho ou perdido tambem fica fora da fila nova', async () => {
    const m = montar();

    await m.service.radar(operador);

    expect(argsDe(m.lead, IDX_ESPERANDO).where.estagio).toEqual({ is_won: false, is_lost: false });
    expect(argsDe(m.lead, IDX_ESPERANDO).where.tenant_id).toBe('t1');
  });
});

describe('LeadInsightsService.radar — filtro por funil', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('com pipeline_id, as 4 filas filtram pelo funil', async () => {
    const m = montar();

    await m.service.radar(operador, 'pipe-1');

    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      expect(argsDe(m.lead, i).where.pipeline_id).toBe('pipe-1');
    }
  });

  it('sem pipeline_id, nenhuma fila filtra por funil', async () => {
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      expect(argsDe(m.lead, i).where.pipeline_id).toBeUndefined();
    }
  });

  it('o funil nao come a visibilidade do pool', async () => {
    const m = montar();
    m.tenant.findUnique.mockResolvedValue({ pool_enabled: true });

    await m.service.radar(operador, 'pipe-1');

    for (let i = 0; i < TODAS_AS_FILAS; i++) {
      expect(argsDe(m.lead, i).where.OR).toEqual([
        { responsavel_id: null, is_private: false },
        { responsavel_id: 'u1' },
      ]);
    }
  });
});

describe('LeadInsightsService.radar — resumo do dia', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('conta as filas e soma o valor dos retornos de hoje', async () => {
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [
        linha({
          id: 'lead-caro',
          nome: 'Cliente Caro',
          valor_estimado: new Prisma.Decimal('1500.50'),
          lead_insight: {
            proxima_acao_at: new Date('2026-08-22T09:00:00Z'),
            proxima_acao_motivo: 'Retomar o orcamento.',
            msg_sugerida: 'Oi!',
          },
        }),
        // Sem valor: conta zero, nao quebra a soma.
        linha({ id: 'lead-sem-valor', valor_estimado: null }),
        linha({ id: 'lead-barato', valor_estimado: new Prisma.Decimal('99.50') }),
      ],
      esperando: [
        esperandoLinha('lead-esp-1', '2026-08-24T08:00:00Z'),
        esperandoLinha('lead-esp-2', '2026-08-24T09:00:00Z'),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.resumo).toEqual({
      esperando: 2,
      chamar_hoje: 3,
      // Decimal do Prisma nao soma sozinho: 1500.50 + 0 + 99.50.
      valor_chamar_hoje: 1600,
      // Destaque = o primeiro de chamar_hoje, que e o mais atrasado.
      lembrete_destaque: { nome: 'Cliente Caro', motivo: 'Retomar o orcamento.' },
    });
  });

  it('a soma sai em reais com centavos, sem sujeira de ponto flutuante', async () => {
    // Decimal -> number -> soma: 0.1 + 0.2 da 0.30000000000000004 em float, e
    // esse numero chega cru na tela como "R$ 0,30000000000000004".
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [
        linha({ id: 'lead-a', valor_estimado: new Prisma.Decimal('0.10') }),
        linha({ id: 'lead-b', valor_estimado: new Prisma.Decimal('0.20') }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.resumo.valor_chamar_hoje).toBe(0.3);
  });

  it('sem chamar_hoje, o destaque e null e o valor e zero', async () => {
    const m = montar();
    mockRadar(m.lead, { esperando: [esperandoLinha('lead-esp-1', '2026-08-24T08:00:00Z')] });

    const radar = await m.service.radar(operador);

    expect(radar.resumo).toEqual({
      esperando: 1,
      chamar_hoje: 0,
      valor_chamar_hoje: 0,
      lembrete_destaque: null,
    });
  });

  it('o resumo conta o que a UI ve, nao o que o banco devolveu (pos-dedupe)', async () => {
    const m = montar();
    mockRadar(m.lead, {
      // O mesmo lead nas duas filas: esperando_voce ganha e chamar_hoje fica vazia.
      vencidos: [linha({ id: 'lead-1', valor_estimado: new Prisma.Decimal('500') })],
      esperando: [esperandoLinha('lead-1', '2026-08-24T08:00:00Z')],
    });

    const radar = await m.service.radar(operador);

    expect(radar.resumo.chamar_hoje).toBe(0);
    expect(radar.resumo.valor_chamar_hoje).toBe(0);
    expect(radar.resumo.lembrete_destaque).toBeNull();
    expect(radar.resumo.esperando).toBe(1);
  });
});

describe('RadarController', () => {
  function montarController() {
    const insights = { radar: jest.fn().mockResolvedValue({}) };
    const controller = new RadarController(insights as unknown as LeadInsightsService);
    return { controller, insights };
  }
  const req = { user: operador } as unknown as Record<string, unknown>;

  it('repassa o pipeline_id da query para o service', async () => {
    const { controller, insights } = montarController();

    await controller.radar(req, { pipeline_id: 'pipe-1' });

    expect(insights.radar).toHaveBeenCalledWith(operador, 'pipe-1');
  });

  it('sem pipeline_id na query, o service recebe undefined', async () => {
    const { controller, insights } = montarController();

    await controller.radar(req, {});

    expect(insights.radar).toHaveBeenCalledWith(operador, undefined);
  });

  it('pipeline_id vazio ("Todos os funis" do select) vale como ausente', async () => {
    const { controller, insights } = montarController();

    await controller.radar(req, { pipeline_id: '' });

    expect(insights.radar).toHaveBeenCalledWith(operador, undefined);
  });

  it('id que nao e uuid passa: existe pipeline real chamado "pipeline-default"', async () => {
    // Ver o comentario em leads.service.ts (createLeadSchema.pipeline_id):
    // validar formato de id aqui quebraria o tenant Default Workspace.
    const { controller, insights } = montarController();

    await controller.radar(req, { pipeline_id: 'pipeline-default' });

    expect(insights.radar).toHaveBeenCalledWith(operador, 'pipeline-default');
  });

  it('o schema descarta chave desconhecida da querystring', async () => {
    // Asserido no schema, nao pelo controller: o controller desestrutura
    // `pipeline_id` e passa posicional, entao `tenant_id` nunca chegaria ao
    // service de qualquer jeito — um teste pelo controller passaria ate com o
    // schema apagado.
    expect(radarQuerySchema.parse({ pipeline_id: 'pipe-1', tenant_id: 'outro-tenant' })).toEqual({
      pipeline_id: 'pipe-1',
    });
  });
});
