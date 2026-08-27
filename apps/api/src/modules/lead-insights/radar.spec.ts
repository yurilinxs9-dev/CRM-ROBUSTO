import { Prisma, UserRole } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AiProviderService } from '../ai/ai-provider.service';
import type { LeadsService } from '../leads/leads.service';
import type { CrmGateway } from '../websocket/websocket.gateway';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadInsightsService, acrescentarAnd } from './lead-insights.service';
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
  // Fase 3: a fila `lembretes_hoje` sai de uma consulta propria (nao e uma
  // sétima consulta de Lead), entao os indices das 6 filas nao mudam.
  const leadLembrete = { findMany: jest.fn() };
  const prisma = { leadInsight, message, lead, tenant, leadLembrete };
  const queue = { add: jest.fn() };
  const ai = { chat: jest.fn() };
  const leads = { findOne: jest.fn() };
  // O radar nao emite nada; o gateway entra so para satisfazer o construtor.
  const gateway = { emitLeadUpdated: jest.fn() };

  const service = new LeadInsightsService(
    prisma as unknown as PrismaService,
    queue as unknown as Queue<GerarInsightJobData>,
    ai as unknown as AiProviderService,
    leads as unknown as LeadsService,
    gateway as unknown as CrmGateway,
  );
  // Modo individual por padrao (o mais restritivo).
  tenant.findUnique.mockResolvedValue({ pool_enabled: false });
  lead.findMany.mockResolvedValue([]);
  leadLembrete.findMany.mockResolvedValue([]);
  return { service, lead, tenant, leadLembrete, prisma };
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
  // `unknown` de proposito nas duas chaves que as filas novas reescrevem com
  // outra forma (`estagio: { is_lost }` em compraram, `lead_insight: { isNot }`
  // em melhores): um tipo fechado aqui so obrigaria cast nos testes.
  estagio?: unknown;
  temperatura?: { in: string[] };
  ultima_interacao?: { lte: Date };
  last_customer_message_at?: { not: null; gte: Date };
  AND?: unknown[];
  lead_insight?: unknown;
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
/** As 4 filas que participam do dedupe por precedencia. */
const TODAS_AS_FILAS = 4;
/**
 * As duas filas da fase 2 vem DEPOIS das 4 antigas na ordem das consultas (e
 * nao antes) so para nao renumerar os indices que os testes da fase 1 usam.
 * Elas ficam FORA do dedupe: `melhores` e um ranking transversal e `compraram`
 * e um universo disjunto (etapa ganha), entao nao entram em `TODAS_AS_FILAS`.
 */
const IDX_MELHORES = 4;
const IDX_COMPRARAM = 5;
const TOTAL_CONSULTAS = 6;

/** Mocka as 6 chamadas do radar na ordem em que o service as dispara. */
function mockRadar(
  lead: { findMany: jest.Mock },
  filas: {
    vencidos?: unknown[];
    quentes?: unknown[];
    parados?: unknown[];
    esperando?: unknown[];
    melhores?: unknown[];
    compraram?: unknown[];
  },
): void {
  lead.findMany
    .mockResolvedValueOnce(filas.vencidos ?? [])
    .mockResolvedValueOnce(filas.quentes ?? [])
    .mockResolvedValueOnce(filas.parados ?? [])
    .mockResolvedValueOnce(filas.esperando ?? [])
    .mockResolvedValueOnce(filas.melhores ?? [])
    .mockResolvedValueOnce(filas.compraram ?? []);
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
      // Campos da fase 2: presentes em TODA fila (o card e um so), nulos quando
      // o lead nao tem valor nem ficha com nota/compra.
      valor_estimado: null,
      nota_atendimento: null,
      compra: null,
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

  it('as 6 secoes pedem responsavel e tags ao banco', async () => {
    // O mock devolve o que quiser: sem conferir o `select`, a UI ficaria sem
    // dono e sem tag em producao com a suite verde.
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
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
      // Fase 2: os dois campos novos do card saem da ficha. Sem eles no select,
      // `nota_atendimento`/`compra` chegariam sempre nulos em producao — e o
      // score de `melhores` cairia no default de nota para TODO mundo.
      expect(select.lead_insight).toEqual({
        select: {
          proxima_acao_at: true,
          proxima_acao_motivo: true,
          msg_sugerida: true,
          nota_atendimento: true,
          ultima_compra: true,
        },
      });
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

    expect(m.lead.findMany).toHaveBeenCalledTimes(TOTAL_CONSULTAS);
    // `compraram` e a excecao proposital (etapa ganha E o universo dela), por
    // isso o loop para nas filas de trabalho.
    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
      if (i === IDX_COMPRARAM) continue;
      expect(argsDe(m.lead, i).where.estagio).toEqual({ is_won: false, is_lost: false });
      expect(argsDe(m.lead, i).where.tenant_id).toBe('t1');
    }
  });

  it('OPERADOR em modo individual so ve os leads dele', async () => {
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
      expect(argsDe(m.lead, i).where.responsavel_id).toBe('u1');
    }
  });

  it('modo compartilhado: o OR do pool sobrevive nas 6 secoes, ao lado do filtro da secao', async () => {
    // O `where` trafega como Record<string, unknown>: nada de tipo impede uma
    // secao futura de trazer o proprio `OR` e comer o da visibilidade em
    // silencio — o que vazaria lead de outro operador com a suite verde.
    const m = montar();
    m.tenant.findUnique.mockResolvedValue({ pool_enabled: true });

    await m.service.radar(operador);

    const orDoPool = [{ responsavel_id: null, is_private: false }, { responsavel_id: 'u1' }];
    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
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

    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
      expect(argsDe(m.lead, i).where.responsavel_id).toBeUndefined();
    }
  });

  it('cap de 30 por secao', async () => {
    const m = montar();
    const muitos = Array.from({ length: 40 }, (_, i) => linha({ id: `lead-${i}` }));
    // As 4 filas devolvem os MESMOS 40 leads: o pior caso do dedupe.
    m.lead.findMany.mockResolvedValue(muitos);

    const radar = await m.service.radar(operador);

    // Precedencia: esperando_voce serve primeiro e leva os 30.
    expect(radar.esperando_voce).toHaveLength(30);
    // As outras secoes recebem os mesmos ids: o dedupe come o resto.
    expect(radar.chamar_hoje).toHaveLength(10);
    expect(radar.promissores).toHaveLength(0);
    expect(radar.esfriando).toHaveLength(0);
  });

  it('as filas pedem folga ao banco: cap 30 nao pode virar o take da consulta', async () => {
    // Com `take: 30`, uma fila de baixo pode render VAZIA tendo dezenas de leads
    // elegiveis logo abaixo do corte: as filas de cima levam ate 30 ids cada uma,
    // e a de baixo so recebeu 30 linhas para comecar. Pior: o `resumo` novo
    // anunciaria "0 retornos hoje" com o banco cheio deles. A ultima fila pode
    // perder ate 90 ids (3 x 30) para as anteriores, entao 30 * 4 e o piso que
    // garante 30 sobreviventes em qualquer uma delas.
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TOTAL_CONSULTAS; i++) expect(argsDe(m.lead, i).take).toBe(120);
  });

  it('lead nao roubado pela fila de cima continua aparecendo na de baixo', async () => {
    const m = montar();
    // 35 esperando: a fila corta em 30, entao lead-30..34 NAO entram no dedupe.
    const esperando = Array.from({ length: 35 }, (_, i) =>
      esperandoLinha(`lead-${i}`, '2026-08-24T08:00:00Z'),
    );
    // chamar_hoje repete os 30 roubados e traz 10 que ninguem levou.
    const vencidos = Array.from({ length: 40 }, (_, i) => linha({ id: `lead-${i}` }));
    mockRadar(m.lead, { vencidos, esperando });

    const radar = await m.service.radar(operador);

    expect(radar.esperando_voce).toHaveLength(30);
    // Os 10 nao roubados sobrevivem — e o resumo do dia enxerga os 10.
    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `lead-${30 + i}`),
    );
    expect(radar.resumo.chamar_hoje).toBe(10);
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

  it('a fila nova pede folga ao banco para o dedupe (cap * numero de filas)', async () => {
    const m = montar();

    await m.service.radar(operador);

    expect(argsDe(m.lead, IDX_ESPERANDO).take).toBe(120);
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

describe('acrescentarAnd', () => {
  // Testado direto, e nao pelo `radar()`: hoje o `base` do radar nunca carrega
  // `AND`, entao uma assercao pelo endpoint passaria com ou sem o fix — seria
  // tautologica. Quem protege contra a regressao futura e este teste.
  const condicao = { OR: [{ last_agent_message_at: null }] };

  it('sem AND no base, vira um array so com a condicao da secao', () => {
    expect(acrescentarAnd({ tenant_id: 't1' }, condicao)).toEqual([condicao]);
  });

  it('com AND em array no base, a condicao da secao e ACRESCENTADA, nao substitui', () => {
    // O caso real que vem por ai: `mergeSearchCondition` (lead-visibility.ts)
    // mescla busca textual justamente em AND.
    const busca = { OR: [{ nome: { contains: 'maria' } }] };

    expect(acrescentarAnd({ AND: [busca] }, condicao)).toEqual([busca, condicao]);
  });

  it('com AND objeto unico no base (forma que o Prisma tambem aceita), nada se perde', () => {
    const busca = { OR: [{ nome: { contains: 'maria' } }] };

    expect(acrescentarAnd({ AND: busca }, condicao)).toEqual([busca, condicao]);
  });
});

describe('LeadInsightsService.radar — filtro por funil', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('com pipeline_id, as 6 filas filtram pelo funil', async () => {
    const m = montar();

    await m.service.radar(operador, 'pipe-1');

    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
      expect(argsDe(m.lead, i).where.pipeline_id).toBe('pipe-1');
    }
  });

  it('sem pipeline_id, nenhuma fila filtra por funil', async () => {
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
      expect(argsDe(m.lead, i).where.pipeline_id).toBeUndefined();
    }
  });

  it('o funil nao come a visibilidade do pool', async () => {
    const m = montar();
    m.tenant.findUnique.mockResolvedValue({ pool_enabled: true });

    await m.service.radar(operador, 'pipe-1');

    for (let i = 0; i < TOTAL_CONSULTAS; i++) {
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
      lembretes_hoje: 0,
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
      lembretes_hoje: 0,
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

describe('LeadInsightsService.radar — campos novos do card', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('valor_estimado sai como numero (Decimal nao serializa sozinho)', async () => {
    // `JSON.stringify(Decimal)` devolve `"1500.5"` (string) — a UI faria
    // `toLocaleString` numa string e mostraria NaN ou o texto cru.
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-caro', valor_estimado: new Prisma.Decimal('1500.50') })],
    });

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].valor_estimado).toBe(1500.5);
  });

  it('nota_atendimento vem da ficha e sobrevive ao card', async () => {
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [
        linha({
          id: 'lead-nota',
          lead_insight: {
            proxima_acao_at: null,
            proxima_acao_motivo: 'x',
            msg_sugerida: '',
            nota_atendimento: 7,
            ultima_compra: null,
          },
        }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].nota_atendimento).toBe(7);
  });

  it('lead sem ficha nenhuma: os dois campos novos viram null, sem crash', async () => {
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-sem-ficha', lead_insight: null, valor_estimado: null })],
    });

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje[0].valor_estimado).toBeNull();
    expect(radar.chamar_hoje[0].nota_atendimento).toBeNull();
    expect(radar.chamar_hoje[0].compra).toBeNull();
  });
});

/**
 * Fila `melhores` (Foco do dia). O que estes testes protegem e a FORMULA: ela
 * roda no app (nao da para ordenar por soma ponderada de 5 sinais no Prisma) e
 * um peso trocado nao quebra nada visivelmente — a lista so fica burra.
 *
 * Os pesos privilegiam SINAIS AUTOMATICOS (a agenda da ficha e a atividade real
 * da conversa) porque `temperatura` e campo manual: na pratica quase ninguem
 * preenche, e num tenant onde todo lead ficou FRIO uma formula ancorada nela
 * achataria o ranking inteiro em empate.
 */
describe('LeadInsightsService.radar — fila melhores (foco do dia)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  /**
   * Candidato com os 5 ingredientes do score explicitos.
   * `acaoEmDias`: dias ate a proxima acao da ficha (negativo = ja venceu,
   * `null` = ficha sem agenda).
   */
  function candidato(
    id: string,
    p: {
      temperatura: string;
      valor: string | null;
      nota: number | null;
      parado: number;
      acaoEmDias?: number | null;
    },
  ) {
    const acao = p.acaoEmDias ?? null;
    return linha({
      id,
      temperatura: p.temperatura,
      valor_estimado: p.valor === null ? null : new Prisma.Decimal(p.valor),
      ultima_interacao: new Date(AGORA.getTime() - p.parado * DIA),
      lead_insight: {
        proxima_acao_at: acao === null ? null : new Date(AGORA.getTime() + acao * DIA),
        proxima_acao_motivo: 'Ficha existe.',
        msg_sugerida: 'Oi!',
        nota_atendimento: p.nota,
        ultima_compra: null,
      },
    });
  }

  it('so entram leads COM ficha, e o banco filtra isso (nao a memoria)', async () => {
    const m = montar();

    await m.service.radar(operador);

    const args = argsDe(m.lead, IDX_MELHORES);
    // Sem ficha nao ha agenda nem nota: metade do score seria chute, e o card do
    // foco do dia ficaria mudo (sem motivo, sem mensagem sugerida).
    expect(args.where.lead_insight).toEqual({ isNot: null });
    // Etapa ativa: a base de trabalho, igual as filas da fase 1.
    expect(args.where.estagio).toEqual({ is_won: false, is_lost: false });
    // Quem ordena e o score no app; o banco so entrega um lote grande e recente.
    expect(args.orderBy).toEqual({ ultima_interacao: 'desc' });
  });

  it('o score composto ordena: temperatura nao decide sozinha', async () => {
    const m = montar();
    mockRadar(m.lead, {
      // Ordem de entrada embaralhada de proposito.
      melhores: [
        // 0 + 0 + 0 + 2 + 0 = 2.0
        candidato('lead-ultimo', { temperatura: 'FRIO', valor: null, nota: null, parado: 40 }),
        // 0 + 2.5 + 3 + 3.2 + 3 = 11.7
        candidato('lead-segundo', {
          temperatura: 'MUITO_QUENTE',
          valor: '5000',
          nota: 8,
          parado: 1,
          acaoEmDias: 10,
        }),
        // 1 + 1.5 + 0.6 + 2 + 1 = 6.1
        candidato('lead-terceiro', {
          temperatura: 'MORNO',
          valor: '1000',
          nota: 5,
          parado: 5,
          acaoEmDias: 3,
        }),
        // 3 + 2.5 + 6 + 4 + 0 = 15.5 — um lead FRIO na frente do MUITO_QUENTE,
        // que e exatamente o ponto: quem manda sao os sinais automaticos.
        candidato('lead-topo', {
          temperatura: 'FRIO',
          valor: '20000',
          nota: 10,
          parado: 0,
          acaoEmDias: -1,
        }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual([
      'lead-topo',
      'lead-segundo',
      'lead-terceiro',
      'lead-ultimo',
    ]);
  });

  it('tenant com TODO lead FRIO ainda tem ranking (o caso real que motivou os pesos)', async () => {
    // Temperatura e preenchida a mao e quase ninguem preenche: a maioria dos
    // tenants tem 100% FRIO. Com a temperatura pesando demais, esta lista sairia
    // toda empatada — ou seja, na ordem crua do banco, sem foco nenhum.
    const m = montar();
    mockRadar(m.lead, {
      melhores: [
        // 0 + 0 + 0 + 0.4 + 0 = 0.4
        candidato('frio-d', { temperatura: 'FRIO', valor: null, nota: 1, parado: 60 }),
        // 0 + 0.5 + 0 + 2 + 0 = 2.5
        candidato('frio-c', { temperatura: 'FRIO', valor: null, nota: null, parado: 20 }),
        // 3 + 2.5 + 1.8 + 3.6 + 0 = 10.9
        candidato('frio-a', {
          temperatura: 'FRIO',
          valor: '3000',
          nota: 9,
          parado: 1,
          acaoEmDias: -2,
        }),
        // 1 + 1.5 + 1.2 + 2.8 + 0 = 6.5
        candidato('frio-b', {
          temperatura: 'FRIO',
          valor: '2000',
          nota: 7,
          parado: 5,
          acaoEmDias: 5,
        }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['frio-a', 'frio-b', 'frio-c', 'frio-d']);
  });

  it('a agenda da ficha da degrau: 48h, 7 dias e depois nada', async () => {
    const m = montar();
    const base = { temperatura: 'MORNO' as const, valor: null, nota: 5, parado: 3 };
    mockRadar(m.lead, {
      melhores: [
        // 0 + 1.5 + 0 + 2 + 1 = 4.5
        candidato('acao-longe', { ...base, acaoEmDias: 20 }),
        // 3 + 1.5 + 0 + 2 + 1 = 7.5 — 48h exatos ainda contam como "e agora".
        candidato('acao-48h', { ...base, acaoEmDias: 2 }),
        // 1 + 1.5 + 0 + 2 + 1 = 5.5
        candidato('acao-semana', { ...base, acaoEmDias: 6 }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual([
      'acao-48h',
      'acao-semana',
      'acao-longe',
    ]);
  });

  it('acao ja vencida pontua como a de hoje (atrasado nao vira menos urgente)', async () => {
    const m = montar();
    const base = { temperatura: 'MORNO' as const, valor: null, nota: 5, parado: 3 };
    mockRadar(m.lead, {
      melhores: [
        candidato('acao-semana', { ...base, acaoEmDias: 6 }),
        candidato('acao-vencida', { ...base, acaoEmDias: -9 }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['acao-vencida', 'acao-semana']);
  });

  it('ficha sem agenda nao pontua nesse sinal, mas continua na lista', async () => {
    const m = montar();
    const base = { temperatura: 'MORNO' as const, valor: null, nota: 5, parado: 3 };
    mockRadar(m.lead, {
      melhores: [
        candidato('sem-agenda', { ...base, acaoEmDias: null }),
        candidato('com-agenda', { ...base, acaoEmDias: 1 }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['com-agenda', 'sem-agenda']);
  });

  it('recencia da degrau: 2 dias, 7 dias, 30 dias e depois nada', async () => {
    const m = montar();
    const base = { temperatura: 'MORNO' as const, valor: null, nota: 5 };
    mockRadar(m.lead, {
      melhores: [
        candidato('lead-antigao', { ...base, parado: 40 }),
        candidato('lead-mes', { ...base, parado: 20 }),
        candidato('lead-ontem', { ...base, parado: 1 }),
        candidato('lead-semana', { ...base, parado: 5 }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual([
      'lead-ontem',
      'lead-semana',
      'lead-mes',
      'lead-antigao',
    ]);
  });

  it('valor tem teto: negocio de R$ 1 milhao nao atropela o resto da formula', async () => {
    // Sem `min(valor/1000, 10)` o lead de 1M pontuaria 600 e a lista viraria um
    // ranking so de valor — que e o kanban, nao o foco do dia.
    const m = montar();
    mockRadar(m.lead, {
      melhores: [
        // 0 + 0 + 6 (teto) + 0 + 0 = 6.0
        candidato('lead-caro-frio', {
          temperatura: 'FRIO',
          valor: '1000000',
          nota: 0,
          parado: 40,
        }),
        // 3 + 2.5 + 0 + 2 + 1 = 8.5
        candidato('lead-morno-ativo', {
          temperatura: 'MORNO',
          valor: null,
          nota: null,
          parado: 1,
          acaoEmDias: 1,
        }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['lead-morno-ativo', 'lead-caro-frio']);
  });

  it('ficha sem nota vale 5 (neutro), nao zero', async () => {
    // Nota e opcional na ficha; tratar ausencia como zero puniria o lead por um
    // campo que o modelo simplesmente nao preencheu.
    const m = montar();
    mockRadar(m.lead, {
      melhores: [
        candidato('lead-nota-zero', { temperatura: 'MORNO', valor: null, nota: 0, parado: 40 }),
        candidato('lead-sem-nota', { temperatura: 'MORNO', valor: null, nota: null, parado: 40 }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['lead-sem-nota', 'lead-nota-zero']);
  });

  it('lead sem interacao registrada nao quebra o score (recencia zero)', async () => {
    const m = montar();
    mockRadar(m.lead, {
      melhores: [
        linha({
          id: 'lead-sem-interacao',
          ultima_interacao: null,
          lead_insight: {
            proxima_acao_at: null,
            proxima_acao_motivo: 'x',
            msg_sugerida: '',
            nota_atendimento: null,
            ultima_compra: null,
          },
        }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['lead-sem-interacao']);
  });

  it('top 10: a secao e uma lista de trabalho do dia, nao um relatorio', async () => {
    const m = montar();
    // Score decrescente pelo valor (todos abaixo do teto de 10k): lead-0 e o
    // mais caro.
    const muitos = Array.from({ length: 12 }, (_, i) =>
      candidato(`lead-${i}`, {
        temperatura: 'MORNO',
        valor: String((12 - i) * 800),
        nota: 5,
        parado: 1,
      }),
    );
    mockRadar(m.lead, { melhores: muitos });

    const radar = await m.service.radar(operador);

    expect(radar.melhores).toHaveLength(10);
    expect(radar.melhores.map((i) => i.lead_id)).toEqual(
      Array.from({ length: 10 }, (_, i) => `lead-${i}`),
    );
  });

  it('o score NAO vai no payload: a UI nunca mostra numero de IA', async () => {
    const m = montar();
    mockRadar(m.lead, {
      melhores: [candidato('lead-1', { temperatura: 'QUENTE', valor: '1000', nota: 9, parado: 1 })],
    });

    const radar = await m.service.radar(operador);

    expect(radar.melhores[0]).not.toHaveProperty('score');
    // O card e o MESMO das outras filas — nada de shape especial.
    expect(radar.melhores[0].motivo).toBe('Ficha existe.');
  });

  it('ranking transversal: o mesmo lead PODE estar em melhores e em outra fila', async () => {
    // De proposito, ao contrario das 4 filas de trabalho: "foco do dia" nao e
    // uma quinta caixa de tarefas, e uma leitura por cima das mesmas pessoas.
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-1' })],
      esperando: [esperandoLinha('lead-2', '2026-08-24T08:00:00Z')],
      melhores: [
        candidato('lead-1', { temperatura: 'QUENTE', valor: '9000', nota: 9, parado: 1 }),
        candidato('lead-2', { temperatura: 'MORNO', valor: '100', nota: 5, parado: 3 }),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-1']);
    expect(radar.esperando_voce.map((i) => i.lead_id)).toEqual(['lead-2']);
    expect(radar.melhores.map((i) => i.lead_id)).toEqual(['lead-1', 'lead-2']);
  });

  it('melhores nao rouba lead das filas de trabalho (fica fora do dedupe)', async () => {
    // A consulta de melhores roda ANTES do dedupe na ordem do Promise.all: se
    // ela alimentasse o Set de vistos, esvaziaria as filas da fase 1.
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-1' })],
      melhores: [candidato('lead-1', { temperatura: 'QUENTE', valor: '9000', nota: 9, parado: 1 })],
    });

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-1']);
  });
});

/**
 * Fila `compraram` (pos-venda). Universo disjunto do resto do radar: aqui a
 * etapa GANHA e o que interessa, e a base do radar exclui exatamente ela.
 */
describe('LeadInsightsService.radar — fila compraram', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  const COMPRA = { descricao: 'Mesa Requinte', valor: 3990, quando: 'mes passado' };

  function comprador(id: string, compra: unknown = COMPRA, over: Record<string, unknown> = {}) {
    return linha({
      id,
      lead_insight: {
        proxima_acao_at: null,
        proxima_acao_motivo: 'Perguntar se chegou tudo certo.',
        msg_sugerida: 'Oi! A mesa chegou bem?',
        nota_atendimento: 9,
        ultima_compra: compra,
      },
      ...over,
    });
  }

  it('entra quem fechou OU quem citou compra na conversa — e o banco resolve o OU', async () => {
    // Filtrar em memoria seria furado do mesmo jeito da fila esperando_voce: o
    // lote vem cortado por `take` e a secao apareceria vazia com o banco cheio.
    const m = montar();

    await m.service.radar(operador);

    const { where } = argsDe(m.lead, IDX_COMPRARAM);
    // Perdido continua fora (negocio morto nao e pos-venda), mas GANHO e
    // justamente o que esta fila procura.
    expect(where.estagio).toEqual({ is_lost: false });
    // O OU vai aninhado em AND para nao comer o OR da visibilidade (mesma
    // armadilha da fila esperando_voce).
    expect(where.AND).toEqual([
      {
        OR: [
          { estagio: { is_won: true } },
          { lead_insight: { ultima_compra: { not: Prisma.DbNull } } },
        ],
      },
    ]);
    expect(where.tenant_id).toBe('t1');
  });

  it('qualquer recencia: cliente que comprou ano passado continua sendo pos-venda', async () => {
    const m = montar();

    await m.service.radar(operador);

    const { where, orderBy } = argsDe(m.lead, IDX_COMPRARAM);
    expect(where.ultima_interacao).toBeUndefined();
    // Do contato mais recente para o mais antigo (ao contrario das filas de
    // trabalho, onde o mais parado e o mais urgente).
    expect(orderBy).toEqual({ ultima_interacao: 'desc' });
  });

  it('a compra chega tipada no card', async () => {
    const m = montar();
    mockRadar(m.lead, { compraram: [comprador('lead-comprou')] });

    const radar = await m.service.radar(operador);

    expect(radar.compraram[0].compra).toEqual({
      descricao: 'Mesa Requinte',
      valor: 3990,
      quando: 'mes passado',
    });
  });

  it('Json quebrado na ficha vira compra null, nao card quebrado', async () => {
    // A coluna e Json cru: ficha antiga, string solta ou objeto sem descricao.
    const m = montar();
    mockRadar(m.lead, {
      compraram: [
        comprador('lead-string', 'comprou uma mesa'),
        comprador('lead-sem-descricao', { valor: 100, quando: 'ontem' }),
        comprador('lead-descricao-vazia', { descricao: '   ', valor: 100, quando: 'ontem' }),
        comprador('lead-nulo', null),
      ],
    });

    const radar = await m.service.radar(operador);

    expect(radar.compraram.map((i) => i.compra)).toEqual([null, null, null, null]);
  });

  it('compra sem valor ou sem data ainda vale (o cliente nem sempre diz)', async () => {
    const m = montar();
    mockRadar(m.lead, {
      compraram: [comprador('lead-parcial', { descricao: 'Sofa Bali' })],
    });

    const radar = await m.service.radar(operador);

    expect(radar.compraram[0].compra).toEqual({
      descricao: 'Sofa Bali',
      valor: null,
      quando: '',
    });
  });

  it('lead ganho sem compra estruturada entra assim mesmo (a etapa ja diz)', async () => {
    const m = montar();
    mockRadar(m.lead, { compraram: [linha({ id: 'lead-ganho', lead_insight: null })] });

    const radar = await m.service.radar(operador);

    expect(radar.compraram.map((i) => i.lead_id)).toEqual(['lead-ganho']);
    expect(radar.compraram[0].compra).toBeNull();
  });

  it('cap de 30 cards', async () => {
    const m = montar();
    mockRadar(m.lead, {
      compraram: Array.from({ length: 40 }, (_, i) => comprador(`lead-${i}`)),
    });

    const radar = await m.service.radar(operador);

    expect(radar.compraram).toHaveLength(30);
  });

  it('sem dedupe: cliente que comprou e segue em conversa aparece nas duas filas', async () => {
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-1' })],
      compraram: [comprador('lead-1')],
    });

    const radar = await m.service.radar(operador);

    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-1']);
    expect(radar.compraram.map((i) => i.lead_id)).toEqual(['lead-1']);
  });
});

describe('LeadInsightsService.radar — resumo nao muda com as filas da fase 2', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  it('melhores e compraram nao entram na conta nem na soma do dia', async () => {
    // O resumo e o header "o que fazer hoje": pos-venda e ranking transversal
    // inflariam um numero que a lista abaixo dele nao mostra.
    const m = montar();
    mockRadar(m.lead, {
      vencidos: [linha({ id: 'lead-1', valor_estimado: new Prisma.Decimal('100') })],
      melhores: Array.from({ length: 5 }, (_, i) =>
        linha({ id: `lead-m-${i}`, valor_estimado: new Prisma.Decimal('900') }),
      ),
      compraram: Array.from({ length: 7 }, (_, i) =>
        linha({ id: `lead-c-${i}`, valor_estimado: new Prisma.Decimal('900') }),
      ),
    });

    const radar = await m.service.radar(operador);

    expect(radar.resumo).toEqual({
      esperando: 0,
      chamar_hoje: 1,
      valor_chamar_hoje: 100,
      lembrete_destaque: { nome: 'Cliente Teste', motivo: 'Confirmar a proposta enviada.' },
      lembretes_hoje: 0,
    });
  });
});

/**
 * Fase 3: fila `lembretes_hoje`. Nao e uma consulta de Lead — sai direto de
 * `leadLembrete.findMany`, com o lead junto. Por isso ela nao mexe nos indices
 * das 6 filas nem entra no dedupe por precedencia: aviso datado que o CLIENTE
 * pediu nao disputa espaco com fila de trabalho.
 */
describe('LeadInsightsService.radar — fila lembretes de hoje', () => {
  /** 25/08 09:00 em Sao Paulo (-03): o dia acaba as 23:59:59.999 locais. */
  const FIM_DO_DIA_SP = new Date('2026-08-26T02:59:59.999Z');
  /** Comeco de AMANHA em Sao Paulo: o primeiro instante que a fila NAO pega. */
  const AMANHA_SP = new Date('2026-08-26T03:00:00.000Z');

  interface ArgsLembrete {
    where: {
      tenant_id?: string;
      status?: string;
      avisar_em?: { lte: Date };
      lead?: { tenant_id?: string; pipeline_id?: string; responsavel_id?: string; OR?: unknown[] };
    };
    select: { lead?: unknown };
    orderBy: Record<string, unknown>;
    take: number;
  }

  function argsLembrete(leadLembrete: { findMany: jest.Mock }): ArgsLembrete {
    const [args] = leadLembrete.findMany.mock.calls[0] as [ArgsLembrete];
    return args;
  }

  function lembrete(over: Record<string, unknown> = {}) {
    return {
      id: 'lem-1',
      motivo: 'Cliente pediu para chamar depois da reforma',
      dito_em: new Date('2026-07-10T14:00:00Z'),
      avisar_em: new Date('2026-08-25T03:00:00Z'),
      lead: linha(),
      ...over,
    };
  }

  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(AGORA);
  });
  afterEach(() => jest.useRealTimers());

  // (f)
  it('lembrete de hoje e atrasado entram com o contexto e o lead montado', async () => {
    const m = montar();
    m.leadLembrete.findMany.mockResolvedValue([
      lembrete({
        id: 'lem-atrasado',
        motivo: 'Disse que so depois da reforma',
        avisar_em: new Date('2026-08-23T03:00:00Z'),
        lead: linha({ id: 'lead-a', nome: 'Cliente Reforma' }),
      }),
      lembrete({ id: 'lem-hoje', lead: linha({ id: 'lead-b' }) }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.lembretes_hoje).toHaveLength(2);
    expect(radar.lembretes_hoje[0]).toEqual({
      lembrete_id: 'lem-atrasado',
      motivo: 'Disse que so depois da reforma',
      // Datas viajam como ISO: o contexto ("em 10/07 ele disse...") e a UI que
      // formata, e Date cru viraria string dupla no JSON.
      dito_em: '2026-07-10T14:00:00.000Z',
      avisar_em: '2026-08-23T03:00:00.000Z',
      // O card do lead e o MESMO das outras filas.
      lead: expect.objectContaining({
        lead_id: 'lead-a',
        nome: 'Cliente Reforma',
        etapa: 'Proposta',
        msg_sugerida: 'Oi! Conseguiu ver a proposta?',
        responsavel: 'Vendedor Um',
        tags: ['Orcamento', 'VIP'],
      }),
    });
    expect(radar.lembretes_hoje[1].lead.lead_id).toBe('lead-b');
  });

  it('o corte e o FIM do dia em Sao Paulo: o lembrete de amanha fica de fora', async () => {
    const m = montar();

    await m.service.radar(operador);

    const args = argsLembrete(m.leadLembrete);
    expect(args.where.avisar_em).toEqual({ lte: FIM_DO_DIA_SP });
    // Meia-noite UTC nao serve: as 21h de Sao Paulo o dia ainda nao acabou e o
    // lembrete de hoje sumiria da tela do vendedor.
    expect(args.where.avisar_em?.lte.getTime()).toBeGreaterThan(AGORA.getTime());
    expect(args.where.avisar_em?.lte.getTime()).toBeLessThan(AMANHA_SP.getTime());
  });

  it('so pendente entra: feito e descartado o BANCO filtra', async () => {
    const m = montar();

    await m.service.radar(operador);

    expect(argsLembrete(m.leadLembrete).where.status).toBe('pendente');
  });

  it('o tenant e exigido no PROPRIO lembrete, nao so no lead da relacao', async () => {
    // Duas razoes. Indice: `@@index([tenant_id, status, avisar_em])` so entra em
    // jogo com o tenant na coluna do lembrete — sem ele o banco varre a tabela
    // inteira e junta com Lead para depois filtrar. E defesa em profundidade: o
    // recorte de tenant deixa de depender de UMA condicao dentro da relacao.
    const m = montar();

    await m.service.radar(operador);

    const { where } = argsLembrete(m.leadLembrete);
    expect(where.tenant_id).toBe('t1');
    // E o recorte do lead continua inteiro: um nao substitui o outro.
    expect(where.lead?.tenant_id).toBe('t1');
  });

  it('pede o lead com o mesmo select das outras filas, do mais antigo, cap 30', async () => {
    const m = montar();

    await m.service.radar(operador);

    const args = argsLembrete(m.leadLembrete);
    // Sem isso o card do lembrete chegaria sem dono, sem tag e sem ficha.
    expect(args.select.lead).toEqual({ select: argsDe(m.lead, IDX_VENCIDOS).select });
    // Mais atrasado primeiro, como chamar_hoje.
    expect(args.orderBy).toEqual({ avisar_em: 'asc' });
    // Sem dedupe, nao ha o que roubar: o cap da secao ja e o take da consulta.
    expect(args.take).toBe(30);
  });

  it('cap de 30 cards', async () => {
    const m = montar();
    m.leadLembrete.findMany.mockResolvedValue(
      Array.from({ length: 40 }, (_, i) =>
        lembrete({ id: `lem-${i}`, lead: linha({ id: `lead-${i}` }) }),
      ),
    );

    const radar = await m.service.radar(operador);

    // O mock ignora o `take`: o corte no app existe para que um banco que
    // devolva mais (ou um take que alguem mexa) nao inunde a tela.
    expect(radar.lembretes_hoje).toHaveLength(30);
    expect(radar.resumo.lembretes_hoje).toBe(30);
  });

  // (g)
  it('o OR do pool sobrevive no lead da consulta nova (visibilidade nao clobberada)', async () => {
    const m = montar();
    m.tenant.findUnique.mockResolvedValue({ pool_enabled: true });

    await m.service.radar(operador);

    const { lead } = argsLembrete(m.leadLembrete).where;
    expect(lead?.tenant_id).toBe('t1');
    expect(lead?.OR).toEqual([{ responsavel_id: null, is_private: false }, { responsavel_id: 'u1' }]);
    // No pool o vinculo e pelo OR: amarrar responsavel_id esconderia o pool.
    expect(lead?.responsavel_id).toBeUndefined();
  });

  it('modo individual: o lembrete de lead de outro operador nao entra', async () => {
    const m = montar();

    await m.service.radar(operador);

    expect(argsLembrete(m.leadLembrete).where.lead?.responsavel_id).toBe('u1');
  });

  // (h)
  it('pipeline_id recorta a fila; sem ele, nenhum recorte de funil', async () => {
    const m = montar();
    await m.service.radar(operador, 'pipe-1');
    expect(argsLembrete(m.leadLembrete).where.lead?.pipeline_id).toBe('pipe-1');

    const outro = montar();
    await outro.service.radar(operador);
    expect(argsLembrete(outro.leadLembrete).where.lead?.pipeline_id).toBeUndefined();
  });

  // (i)
  it('resumo.lembretes_hoje conta o que a UI recebe', async () => {
    const m = montar();
    m.leadLembrete.findMany.mockResolvedValue([
      lembrete({ id: 'lem-1', lead: linha({ id: 'lead-a' }) }),
      lembrete({ id: 'lem-2', lead: linha({ id: 'lead-b' }) }),
      lembrete({ id: 'lem-3', lead: linha({ id: 'lead-c' }) }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.resumo.lembretes_hoje).toBe(3);
    expect(radar.resumo.lembretes_hoje).toBe(radar.lembretes_hoje.length);
  });

  it('sem dedupe: o lead do lembrete continua aparecendo na fila de trabalho', async () => {
    // Aviso datado que o cliente pediu nao compete com a fila de trabalho: sao
    // duas leituras diferentes do mesmo lead, e sumir com uma delas esconderia
    // justamente o contexto que faz o vendedor ligar.
    const m = montar();
    mockRadar(m.lead, { vencidos: [linha({ id: 'lead-1' })] });
    m.leadLembrete.findMany.mockResolvedValue([lembrete({ lead: linha({ id: 'lead-1' }) })]);

    const radar = await m.service.radar(operador);

    expect(radar.lembretes_hoje.map((l) => l.lead.lead_id)).toEqual(['lead-1']);
    expect(radar.chamar_hoje.map((i) => i.lead_id)).toEqual(['lead-1']);
  });

  it('lembrete de lead sem ficha nao quebra o card', async () => {
    const m = montar();
    m.leadLembrete.findMany.mockResolvedValue([
      lembrete({ lead: linha({ id: 'lead-sem-ficha', lead_insight: null }) }),
    ]);

    const radar = await m.service.radar(operador);

    expect(radar.lembretes_hoje[0].lead.msg_sugerida).toBe('');
    expect(radar.lembretes_hoje[0].lead.proxima_acao_at).toBeNull();
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
