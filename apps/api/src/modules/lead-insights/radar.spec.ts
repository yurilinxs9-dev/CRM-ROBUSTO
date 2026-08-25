import { UserRole } from '@prisma/client';
import type { Queue } from 'bullmq';
import type { PrismaService } from '../../common/prisma/prisma.service';
import type { AiProviderService } from '../ai/ai-provider.service';
import type { LeadsService } from '../leads/leads.service';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadInsightsService } from './lead-insights.service';
import type { GerarInsightJobData } from './lead-insights.queue';

/**
 * Radar comercial: 3 consultas ao Prisma, uma por secao. Mocks na borda, no
 * mesmo espirito do lead-insights.service.spec — o service roda de verdade e
 * as asseracoes caem tanto no `where` enviado (visibilidade, estagio ganho/
 * perdido) quanto no formato do que volta para a UI.
 */
function montar() {
  const leadInsight = { findUnique: jest.fn(), upsert: jest.fn() };
  const message = { count: jest.fn(), findMany: jest.fn() };
  const lead = { findFirst: jest.fn(), findMany: jest.fn() };
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
  responsavel_id?: string;
  OR?: unknown[];
  estagio?: { is_won: boolean; is_lost: boolean };
  temperatura?: { in: string[] };
  ultima_interacao?: { lte: Date };
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
    lead_insight: {
      proxima_acao_at: new Date('2026-08-25T09:00:00Z'),
      proxima_acao_motivo: 'Confirmar a proposta enviada.',
      msg_sugerida: 'Oi! Conseguiu ver a proposta?',
    },
    ...over,
  };
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

  it('as 3 secoes pedem responsavel e tags ao banco', async () => {
    // O mock devolve o que quiser: sem conferir o `select`, a UI ficaria sem
    // dono e sem tag em producao com a suite verde.
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < 3; i++) {
      const { select } = argsDe(m.lead, i);
      expect(select.responsavel).toEqual({ select: { nome: true } });
      expect(select.lead_tags).toEqual({
        select: { tag: { select: { nome: true } } },
        // Ordem estavel: sem isso os chips trocam de lugar entre requisicoes.
        orderBy: { tag: { nome: 'asc' } },
      });
      // As duas fontes de tag saem na mesma linha: o Json custa zero a mais.
      expect(select.tags).toBe(true);
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

    expect(m.lead.findMany).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 3; i++) {
      expect(argsDe(m.lead, i).where.estagio).toEqual({ is_won: false, is_lost: false });
      expect(argsDe(m.lead, i).where.tenant_id).toBe('t1');
    }
  });

  it('OPERADOR em modo individual so ve os leads dele', async () => {
    const m = montar();

    await m.service.radar(operador);

    for (let i = 0; i < 3; i++) {
      expect(argsDe(m.lead, i).where.responsavel_id).toBe('u1');
    }
  });

  it('modo compartilhado: o OR do pool sobrevive nas 3 secoes, ao lado do filtro da secao', async () => {
    // O `where` trafega como Record<string, unknown>: nada de tipo impede uma
    // secao futura de trazer o proprio `OR` e comer o da visibilidade em
    // silencio — o que vazaria lead de outro operador com a suite verde.
    const m = montar();
    m.tenant.findUnique.mockResolvedValue({ pool_enabled: true });

    await m.service.radar(operador);

    const orDoPool = [{ responsavel_id: null, is_private: false }, { responsavel_id: 'u1' }];
    for (let i = 0; i < 3; i++) {
      const args = argsDe(m.lead, i);
      expect(args.where.OR).toEqual(orDoPool);
      // No pool, o vinculo e pelo OR: amarrar responsavel_id esconderia o pool.
      expect(args.where.responsavel_id).toBeUndefined();
    }
    // Filtro da secao entra como chave IRMA do OR (AND implicito do Prisma).
    expect(argsDe(m.lead, 0).where.lead_insight).toEqual({ proxima_acao_at: { lte: AGORA } });
    expect(argsDe(m.lead, 1).where.ultima_interacao).toEqual({
      lte: new Date(AGORA.getTime() - 2 * DIA),
    });
    expect(argsDe(m.lead, 2).where.ultima_interacao).toEqual({
      lte: new Date(AGORA.getTime() - 7 * DIA),
    });
  });

  it('GERENTE em modo individual nao e amarrado a responsavel_id', async () => {
    const m = montar();

    await m.service.radar(gerente);

    for (let i = 0; i < 3; i++) {
      expect(argsDe(m.lead, i).where.responsavel_id).toBeUndefined();
    }
  });

  it('cap de 30 por secao', async () => {
    const m = montar();
    const muitos = Array.from({ length: 40 }, (_, i) => linha({ id: `lead-${i}` }));
    m.lead.findMany.mockResolvedValue(muitos);

    const radar = await m.service.radar(operador);

    for (let i = 0; i < 3; i++) expect(argsDe(m.lead, i).take).toBe(30);
    expect(radar.chamar_hoje).toHaveLength(30);
    // As outras secoes recebem os mesmos ids: o dedupe come tudo.
    expect(radar.promissores).toHaveLength(10);
    expect(radar.esfriando).toHaveLength(0);
  });
});
