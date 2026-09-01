import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { inicioDoDiaLocal } from '../lead-insights/lead-insights.service';
import { buildVisibilityWhere, isManagerRole } from '../leads/lead-visibility';
import { UserRole } from '@/common/types/roles';
import type { Prisma } from '@prisma/client';
import type { AuthUser } from '../../common/types/auth-user';

export interface StageRow { id: string; nome: string; cor: string; ordem: number; is_won?: boolean; }

/** Item do funil do `stats` — o shape que o `FunnelChart` do front consome. */
export interface FunilItem {
  stageId: string;
  nome: string;
  cor: string;
  count: number;
}

/** Colunas homonimas sao a MESMA coluna: o clone nasce com o nome da base. */
function normalizarNomeDeColuna(nome: string): string {
  return nome.toLowerCase().trim();
}

/**
 * Kanban individual: cada membro tem um clone proprio de cada coluna
 * (`Stage.user_id`), entao o funil do gestor mostrava "Novo" uma vez por dono,
 * cada uma com um pedaco da contagem. Aqui as homonimas viram um item so.
 *
 * O representante do grupo e a coluna de MENOR `ordem` (empate decidido pelo
 * id, senao a resposta danca entre dois clones na mesma posicao): e dele que
 * saem id, nome e cor, e e por ele que o item se posiciona no funil. Manter o
 * id de uma coluna real importa — o front usa `stageId` como chave de lista.
 */
function agregarFunilPorNome(
  stages: StageRow[],
  contagens: Map<string | null, number>,
): FunilItem[] {
  const grupos = new Map<string, { representante: StageRow; count: number }>();
  for (const stage of stages) {
    const chave = normalizarNomeDeColuna(stage.nome);
    const count = contagens.get(stage.id) ?? 0;
    const grupo = grupos.get(chave);
    if (!grupo) {
      grupos.set(chave, { representante: stage, count });
      continue;
    }
    grupo.count += count;
    if (ehAnterior(stage, grupo.representante)) grupo.representante = stage;
  }
  return [...grupos.values()]
    .sort((a, b) => (ehAnterior(a.representante, b.representante) ? -1 : 1))
    .map(({ representante, count }) => ({
      stageId: representante.id,
      nome: representante.nome,
      cor: representante.cor,
      count,
    }));
}

function ehAnterior(a: StageRow, b: StageRow): boolean {
  if (a.ordem !== b.ordem) return a.ordem < b.ordem;
  return a.id < b.id;
}

const TIMEZONE = 'America/Sao_Paulo';

export interface FinanceiraEtapa {
  stage: { id: string; nome: string; cor: string; ordem: number };
  count: number;
  total: number;
  probabilidade: number;
  ponderado: number;
}

export interface FinanceiraResposta {
  previsao: { total_aberto: number; ponderado: number; por_etapa: FinanceiraEtapa[] };
  ganhos: { mes_atual: number; mes_anterior: number; quantidade_mes: number; ticket_medio: number };
  top_oportunidades: Array<{
    lead_id: string;
    nome: string;
    valor: number;
    etapa: string;
    temperatura: string;
  }>;
}

const FINANCEIRA_VAZIA: FinanceiraResposta = {
  previsao: { total_aberto: 0, ponderado: 0, por_etapa: [] },
  ganhos: { mes_atual: 0, mes_anterior: 0, quantidade_mes: 0, ticket_medio: 0 },
  top_oportunidades: [],
};

/**
 * `valor_estimado` e Decimal: nao soma com `+` e serializa como objeto. Mesmo
 * tratamento do `toNumber` do analytics.service.
 */
function paraNumero(valor: Prisma.Decimal | null | undefined): number {
  if (valor === null || valor === undefined) return 0;
  return valor.toNumber();
}

/** Dinheiro so em centavos: 400.2 + 400 da 800.2000000000001 em float puro. */
function arredondar(valor: number): number {
  return Number(valor.toFixed(2));
}

/**
 * Ano e mes de PAREDE em `timeZone`. `getUTCMonth()` direto erraria a virada:
 * as 21h de 31/marco em Sao Paulo ja e 1o/abril em UTC, e o mes novo comecaria
 * levando os ganhos da ultima noite do mes velho.
 * Formato inesperado cai no relogio do processo — mes um pouco torto e melhor
 * do que `Invalid Date` dentro de um `where`.
 */
function anoMesLocal(instante: Date, timeZone: string): { ano: number; mes: number } {
  const [ano, mes] = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
  })
    .format(instante)
    .split('-')
    .map(Number);
  if (!Number.isFinite(ano) || !Number.isFinite(mes)) {
    return { ano: instante.getFullYear(), mes: instante.getMonth() + 1 };
  }
  return { ano, mes };
}

// Dashboard data changes slowly relative to render frequency — a short TTL
// makes the first hit pay the cost and everyone else gets sub-10ms responses.
// 60s > refetchInterval do front (30s): a maioria dos polls acerta o cache
// em vez de recomputar tudo a cada ciclo.
const DASHBOARD_TTL_SECONDS = 60;

@Injectable()
export class DashboardService {
  constructor(
    private prisma: PrismaService,
    private cache: RedisCacheService,
  ) {}

  private async cached<T>(key: string, loader: () => Promise<T>): Promise<T> {
    const hit = await this.cache.get<T>(key);
    if (hit !== null) return hit;
    const value = await loader();
    await this.cache.set(key, value, DASHBOARD_TTL_SECONDS);
    return value;
  }

  async getFunnel(user: AuthUser, pipelineId?: string) {
    return this.cached(`dash:funnel:${user.tenantId}:${pipelineId ?? 'active'}`, () =>
      this.computeFunnel(user, pipelineId),
    );
  }

  private async computeFunnel(user: AuthUser, pipelineId?: string) {
    const pipeline = pipelineId
      ? await this.prisma.pipeline.findFirst({
          where: { id: pipelineId, tenant_id: user.tenantId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        })
      : await this.prisma.pipeline.findFirst({
          where: { ativo: true, tenant_id: user.tenantId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        });

    if (!pipeline) return [];

    const stageIds = pipeline.stages.map((s) => s.id);
    const grouped = await this.prisma.lead.groupBy({
      by: ['estagio_id'],
      where: { estagio_id: { in: stageIds }, tenant_id: user.tenantId },
      _count: { id: true },
      _sum: { valor_estimado: true },
    });
    const map = new Map(grouped.map((g) => [g.estagio_id, g]));

    return pipeline.stages.map((stage) => {
      const g = map.get(stage.id);
      return {
        stage: { id: stage.id, nome: stage.nome, cor: stage.cor, ordem: stage.ordem },
        count: g?._count.id ?? 0,
        total: g?._sum.valor_estimado ?? 0,
      };
    });
  }

  async getFinanceira(user: AuthUser, pipelineId?: string): Promise<FinanceiraResposta> {
    return this.cached(`dash:financeira:${user.tenantId}:${pipelineId ?? 'active'}`, () =>
      this.computeFinanceira(user, pipelineId),
    );
  }

  private async computeFinanceira(
    user: AuthUser,
    pipelineId?: string,
  ): Promise<FinanceiraResposta> {
    // Mesmo fallback do funil: sem id explicito, o pipeline ativo do tenant.
    const pipeline = pipelineId
      ? await this.prisma.pipeline.findFirst({
          where: { id: pipelineId, tenant_id: user.tenantId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        })
      : await this.prisma.pipeline.findFirst({
          where: { ativo: true, tenant_id: user.tenantId },
          include: { stages: { orderBy: { ordem: 'asc' } } },
        });

    if (!pipeline) return FINANCEIRA_VAZIA;

    // Previsao e o que ainda esta em jogo: ganho ja virou receita e perdido vale
    // zero — somar qualquer um dos dois infla o previsto.
    const abertas = pipeline.stages.filter((s) => !s.is_won && !s.is_lost);
    const abertasIds = abertas.map((s) => s.id);
    const ganhasIds = pipeline.stages.filter((s) => s.is_won).map((s) => s.id);

    const agora = new Date();
    const { ano, mes } = anoMesLocal(agora, TIMEZONE);
    const inicioMes = inicioDoDiaLocal(ano, mes, 1, TIMEZONE);
    // `mes - 1` com mes = 1 vira o mes 0 e o `Date.UTC` interno rola pra
    // dezembro do ano anterior sozinho; `mes + 1` com mes = 12 rola pra janeiro
    // do ano seguinte pelo mesmo caminho.
    const inicioMesAnterior = inicioDoDiaLocal(ano, mes - 1, 1, TIMEZONE);
    // Teto explicito no mes corrente tambem: as duas janelas sao [inicio, fim).
    // Sem ele, um `estagio_entered_at` no futuro (correcao de data na mao, fila
    // atrasada com relogio adiantado) entraria no mes de hoje pra sempre.
    const inicioProximoMes = inicioDoDiaLocal(ano, mes + 1, 1, TIMEZONE);

    type GrupoEtapa = {
      estagio_id: string;
      _count: { id: number };
      _sum: { valor_estimado: Prisma.Decimal | null };
    };
    type AgregadoGanho = {
      _count: { id: number };
      _sum: { valor_estimado: Prisma.Decimal | null };
    };
    type LinhaTop = {
      id: string;
      nome: string;
      valor_estimado: Prisma.Decimal | null;
      temperatura: string;
      estagio: { nome: string } | null;
    };

    // A ordem importa: a primeira chamada de `aggregate` e a do mes corrente.
    const [grupos, ganhoAtual, ganhoAnterior, linhasTop] = (await Promise.all([
      this.prisma.lead.groupBy({
        by: ['estagio_id'],
        where: { estagio_id: { in: abertasIds }, tenant_id: user.tenantId },
        _count: { id: true },
        _sum: { valor_estimado: true },
      }),
      this.prisma.lead.aggregate({
        where: {
          tenant_id: user.tenantId,
          estagio_id: { in: ganhasIds },
          estagio_entered_at: { gte: inicioMes, lt: inicioProximoMes },
        },
        _count: { id: true },
        _sum: { valor_estimado: true },
      }),
      this.prisma.lead.aggregate({
        where: {
          tenant_id: user.tenantId,
          estagio_id: { in: ganhasIds },
          estagio_entered_at: { gte: inicioMesAnterior, lt: inicioMes },
        },
        _count: { id: true },
        _sum: { valor_estimado: true },
      }),
      this.prisma.lead.findMany({
        where: {
          tenant_id: user.tenantId,
          estagio_id: { in: abertasIds },
          valor_estimado: { not: null },
          // Lead privado (regra do `lead-visibility`) fica fora do top pra
          // TODO mundo. A alternativa — filtrar pelo responsavel — partiria o
          // cache por usuario; e um lead marcado como privado nao deveria
          // aparecer com nome e valor num painel gerencial de qualquer jeito.
          is_private: false,
        },
        orderBy: { valor_estimado: 'desc' },
        take: 5,
        select: {
          id: true,
          nome: true,
          valor_estimado: true,
          temperatura: true,
          estagio: { select: { nome: true } },
        },
      }),
    ])) as [GrupoEtapa[], AgregadoGanho, AgregadoGanho, LinhaTop[]];

    const mapa = new Map(grupos.map((g) => [g.estagio_id, g]));
    const por_etapa: FinanceiraEtapa[] = abertas.map((stage, indice) => {
      const g = mapa.get(stage.id);
      const total = arredondar(paraNumero(g?._sum.valor_estimado));
      // Sem probabilidade configurada, a posicao entre as ABERTAS decide:
      // 1 etapa -> 50; 3 -> 25/50/75. `?? ` e nao `||`: 0 e escolha do gestor.
      const probabilidade =
        stage.probabilidade ?? Math.round(((indice + 1) / (abertas.length + 1)) * 100);
      return {
        stage: { id: stage.id, nome: stage.nome, cor: stage.cor, ordem: stage.ordem },
        count: g?._count.id ?? 0,
        total,
        probabilidade,
        ponderado: arredondar((total * probabilidade) / 100),
      };
    });

    const mes_atual = arredondar(paraNumero(ganhoAtual._sum.valor_estimado));
    const quantidade_mes = ganhoAtual._count.id;

    return {
      previsao: {
        total_aberto: arredondar(por_etapa.reduce((soma, e) => soma + e.total, 0)),
        ponderado: arredondar(por_etapa.reduce((soma, e) => soma + e.ponderado, 0)),
        por_etapa,
      },
      ganhos: {
        mes_atual,
        mes_anterior: arredondar(paraNumero(ganhoAnterior._sum.valor_estimado)),
        quantidade_mes,
        // Sem ganho no mes a divisao daria NaN e chegaria na tela como "R$ NaN".
        ticket_medio: quantidade_mes > 0 ? arredondar(mes_atual / quantidade_mes) : 0,
      },
      top_oportunidades: linhasTop.map((l) => ({
        lead_id: l.id,
        nome: l.nome,
        valor: arredondar(paraNumero(l.valor_estimado)),
        etapa: l.estagio?.nome ?? '',
        temperatura: String(l.temperatura),
      })),
    };
  }

  async getPerformance(user: AuthUser) {
    return this.cached(`dash:perf:${user.tenantId}`, () => this.computePerformance(user));
  }

  private async computePerformance(user: AuthUser) {
    const users = await this.prisma.user.findMany({
      where: { ativo: true, role: { not: 'VISUALIZADOR' }, tenant_id: user.tenantId },
      select: { id: true, nome: true, avatar_url: true },
    });
    const userIds = users.map((u) => u.id);

    const [leadsGroup, wonGroup, msgsGroup] = await Promise.all([
      this.prisma.lead.groupBy({
        by: ['responsavel_id'],
        where: { responsavel_id: { in: userIds }, tenant_id: user.tenantId },
        _count: { id: true },
      }),
      this.prisma.lead.groupBy({
        by: ['responsavel_id'],
        where: {
          responsavel_id: { in: userIds },
          tenant_id: user.tenantId,
          estagio: { is_won: true },
        },
        _count: { id: true },
      }),
      this.prisma.message.groupBy({
        by: ['sent_by_user_id'],
        where: {
          sent_by_user_id: { in: userIds },
          direction: 'OUTGOING',
          tenant_id: user.tenantId,
        },
        _count: { id: true },
      }),
    ]);

    const leadsMap = new Map(leadsGroup.map((g) => [g.responsavel_id, g._count.id]));
    const wonMap = new Map(wonGroup.map((g) => [g.responsavel_id, g._count.id]));
    const msgsMap = new Map(msgsGroup.map((g) => [g.sent_by_user_id, g._count.id]));

    return users.map((u) => ({
      user: u,
      leads_total: leadsMap.get(u.id) ?? 0,
      leads_ganhos: wonMap.get(u.id) ?? 0,
      mensagens_enviadas: msgsMap.get(u.id) ?? 0,
    }));
  }

  /**
   * A chave carrega o USUARIO, nao so o tenant: desde que as contagens
   * respeitam a visibilidade, uma unica entrada por tenant serviria o numero do
   * primeiro que abrisse a tela para o time inteiro — o vazamento que o recorte
   * acabou de fechar, reaberto pelo cache.
   *
   * O modo foco fica FORA da chave de proposito: le-lo aqui custaria uma ida ao
   * banco em todo acerto de cache. O preco e o teto do TTL (60s) de numero
   * velho depois de ligar/desligar o foco.
   */
  async getStats(user: AuthUser) {
    return this.cached(`dash:stats:${user.tenantId}:${user.id}`, () => this.computeStats(user));
  }

  private async computeStats(user: AuthUser) {
    const now = new Date();

    // Mesma leitura de contexto do board (leads.service.findAll): o dashboard
    // nao pode ter uma regra de visibilidade PROPRIA — seria uma porta lateral
    // para o que o Kanban fecha.
    const [tenant, me] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: user.tenantId },
        select: { pool_enabled: true, kanban_individual: true },
      }),
      this.prisma.user.findUnique({
        where: { id: user.id },
        select: { focus_mode: true },
      }),
    ]);
    const role = user.role as UserRole;
    const focusMode = Boolean(me?.focus_mode);
    // Supervisionando = ve os numeros da loja. Gerente em modo foco NAO
    // supervisiona: o painel dele vira o painel da propria carteira.
    const supervisionando = isManagerRole(role) && !focusMode;
    const kanbanIndividual = tenant?.kanban_individual === true;
    // Cast pontual, no padrao do lead-insights: `buildVisibilityWhere` devolve
    // Record<string, unknown> por contrato — nao ha tipo a estreitar, so forma.
    const visibilidade = buildVisibilityWhere({
      userId: user.id,
      role,
      poolEnabled: Boolean(tenant?.pool_enabled),
      focusMode,
    }) as Prisma.LeadWhereInput;
    // `tenant_id` primeiro e a visibilidade por cima: ela so escreve `OR` /
    // `responsavel_id`, entao nunca come o recorte de tenant.
    const leadWhere: Prisma.LeadWhereInput = { tenant_id: user.tenantId, ...visibilidade };

    const startOfThisWeek = new Date(now);
    startOfThisWeek.setDate(now.getDate() - 7);
    const startOfLastWeek = new Date(now);
    startOfLastWeek.setDate(now.getDate() - 14);

    // Group ALL tenant leads by their actual estagio_id — the previous
    // implementation filtered by the stages of the "ativo: true" pipeline,
    // so leads sitting in any other pipeline (or with a stale active flag)
    // rendered as zero in the funnel even when totalLeads > 0.
    // Prisma's groupBy return types get lost through Promise.all in some TS
    // versions, so we type the rows locally to keep the downstream code safe.
    type GroupRow<K extends string> = { [P in K]: string | null } & {
      _count: { id: number };
    };
    const [stageGroup, totalLeads, leadsThisWeek, leadsLastWeek, tempGroup, recentLeadActivities, operatorGroup] =
      (await Promise.all([
        this.prisma.lead.groupBy({
          by: ['estagio_id'],
          where: leadWhere,
          _count: { id: true },
        }),
        this.prisma.lead.count({ where: leadWhere }),
        this.prisma.lead.count({
          where: { ...leadWhere, created_at: { gte: startOfThisWeek } },
        }),
        this.prisma.lead.count({
          where: {
            ...leadWhere,
            created_at: { gte: startOfLastWeek, lt: startOfThisWeek },
          },
        }),
        this.prisma.lead.groupBy({
          by: ['temperatura'],
          where: leadWhere,
          _count: { id: true },
        }),
        this.prisma.leadActivity.findMany({
          // A atividade recente carrega NOME de lead: sem o recorte pela
          // relacao, o operador lia o movimento da carteira dos colegas.
          where: { tenant_id: user.tenantId, lead: visibilidade },
          orderBy: { created_at: 'desc' },
          take: 10,
          include: {
            lead: { select: { nome: true } },
            user: { select: { nome: true } },
          },
        }),
        this.prisma.lead.groupBy({
          by: ['responsavel_id'],
          where: leadWhere,
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
          take: 5,
        }),
      ])) as [
        GroupRow<'estagio_id'>[],
        number,
        number,
        number,
        GroupRow<'temperatura'>[],
        Array<{ id: string; tipo: string; created_at: Date; lead: { nome: string } | null; user: { nome: string } | null }>,
        GroupRow<'responsavel_id'>[],
      ];

    // Resolve only the stages that actually have leads attached.
    const usedStageIds = stageGroup
      .map((g) => g.estagio_id)
      .filter((id): id is string => !!id);
    const usedStages = usedStageIds.length
      ? ((await this.prisma.stage.findMany({
          where: { id: { in: usedStageIds }, tenant_id: user.tenantId },
          // Desempate pelo id: com kanban individual varios clones dividem a
          // mesma `ordem`, e sem criterio estavel a lista muda de ordem sozinha.
          orderBy: [{ ordem: 'asc' }, { id: 'asc' }],
        })) as StageRow[])
      : [];

    const stageCountMap = new Map(
      stageGroup.map((g) => [g.estagio_id, g._count.id]),
    );
    // Com o toggle ligado o funil fala de COLUNAS (por nome), nao de clones.
    // Desligado, nada muda: um item por estagio, como sempre foi.
    const stageCounts: FunilItem[] = kanbanIndividual
      ? agregarFunilPorNome(usedStages, stageCountMap)
      : usedStages.map((s) => ({
          stageId: s.id,
          nome: s.nome,
          cor: s.cor,
          count: stageCountMap.get(s.id) ?? 0,
        }));

    const wonStageIds = usedStages.filter((s) => s.is_won).map((s) => s.id);
    const wonCount = wonStageIds.length
      ? stageGroup
          .filter((g) => g.estagio_id && wonStageIds.includes(g.estagio_id))
          .reduce((a, g) => a + g._count.id, 0)
      : 0;
    const conversionRate = totalLeads > 0 ? Math.round((wonCount / totalLeads) * 100) : 0;

    const leadsByTemp = tempGroup.map((t) => ({
      temperatura: String(t.temperatura),
      count: t._count.id,
    }));

    const recentActivity = recentLeadActivities.map((a) => ({
      id: a.id,
      leadNome: a.lead?.nome ?? '',
      action: a.tipo,
      operatorNome: a.user?.nome ?? 'Sistema',
      createdAt: a.created_at,
    }));

    // Ranking e visao de GESTAO. Escopado, o groupBy so pode devolver o proprio
    // usuario e a fila sem dono — e a fila sem dono viraria uma linha
    // "Desconhecido" liderando o proprio ranking do operador.
    const operatorRows = supervisionando
      ? operatorGroup
      : operatorGroup.filter((g) => g.responsavel_id === user.id);
    const operatorIds = operatorRows
      .map((g) => g.responsavel_id)
      .filter((id): id is string => !!id);
    const [operators, msgsByOp] = (await Promise.all([
      operatorIds.length
        ? this.prisma.user.findMany({
            where: { id: { in: operatorIds }, tenant_id: user.tenantId },
            select: { id: true, nome: true },
          })
        : Promise.resolve([] as { id: string; nome: string }[]),
      operatorIds.length
        ? this.prisma.message.groupBy({
            by: ['sent_by_user_id'],
            where: {
              sent_by_user_id: { in: operatorIds },
              direction: 'OUTGOING',
              tenant_id: user.tenantId,
            },
            _count: { id: true },
          })
        : Promise.resolve([] as { sent_by_user_id: string | null; _count: { id: number } }[]),
    ])) as [
      Array<{ id: string; nome: string }>,
      Array<{ sent_by_user_id: string | null; _count: { id: number } }>,
    ];
    const msgsMap = new Map(msgsByOp.map((m) => [m.sent_by_user_id, m._count.id]));
    const topOperators = operatorRows.map((g) => {
      const u = operators.find((o) => o.id === g.responsavel_id);
      return {
        id: g.responsavel_id,
        nome: u?.nome ?? 'Desconhecido',
        leadsCount: g._count.id,
        messagesSent: msgsMap.get(g.responsavel_id) ?? 0,
        avgResponse: 0,
      };
    });

    // ---- Métricas adicionais (additivas, não quebram o contrato anterior) ----
    const since14 = new Date(now);
    since14.setDate(now.getDate() - 13);
    since14.setHours(0, 0, 0, 0);

    const [respLeads, openConversations, pendingTasks, wonValueAgg, trendRows] =
      (await Promise.all([
        this.prisma.lead.findMany({
          where: {
            ...leadWhere,
            last_customer_message_at: { not: null },
            last_agent_message_at: { not: null },
          },
          select: { last_customer_message_at: true, last_agent_message_at: true },
          orderBy: { ultima_interacao: 'desc' },
          take: 500,
        }),
        this.prisma.lead.count({
          where: { ...leadWhere, mensagens_nao_lidas: { gt: 0 } },
        }),
        this.prisma.task.count({
          // Tarefa segue a regra do proprio modulo (tasks.service.scopeWhere):
          // quem nao supervisiona conta as SUAS pendencias.
          where: {
            tenant_id: user.tenantId,
            status: 'PENDENTE',
            ...(supervisionando ? {} : { responsavel_id: user.id }),
          },
        }),
        this.prisma.lead.aggregate({
          where: { ...leadWhere, estagio: { is_won: true } },
          _sum: { valor_estimado: true },
        }),
        // Era SQL cru filtrando so por tenant. Repetir a visibilidade a mao em
        // SQL seria uma segunda copia da regra (a que sempre atrasa em relacao
        // a `buildVisibilityWhere`), entao a serie passa a ser lida pelo Prisma
        // com o MESMO `where` e agrupada aqui — sao 14 dias de `created_at`, uma
        // coluna por linha.
        this.prisma.lead.findMany({
          where: { ...leadWhere, created_at: { gte: since14 } },
          select: { created_at: true },
        }),
      ])) as [
        Array<{ last_customer_message_at: Date | null; last_agent_message_at: Date | null }>,
        number,
        number,
        { _sum: { valor_estimado: unknown } },
        Array<{ created_at: Date }>,
      ];

    // Tempo médio de resposta: delta entre última msg do cliente e nossa resposta,
    // ignorando negativos (resposta veio antes) e outliers > 24h.
    const deltas = respLeads
      .filter((l) => l.last_customer_message_at && l.last_agent_message_at)
      .map(
        (l) =>
          (l.last_agent_message_at!.getTime() - l.last_customer_message_at!.getTime()) / 60000,
      )
      .filter((d) => d > 0 && d < 60 * 24);
    const avgResponseMinutes = deltas.length
      ? Math.round(deltas.reduce((a, b) => a + b, 0) / deltas.length)
      : 0;

    const wonValue = wonValueAgg._sum.valor_estimado
      ? Number(wonValueAgg._sum.valor_estimado)
      : 0;

    // Série de 14 dias preenchendo lacunas com zero. O balde é o dia em UTC,
    // igual ao `date_trunc` que rodava no banco.
    const trendMap = new Map<string, number>();
    for (const linha of trendRows) {
      const chave = linha.created_at.toISOString().slice(0, 10);
      trendMap.set(chave, (trendMap.get(chave) ?? 0) + 1);
    }
    const leadsTrend: { date: string; count: number }[] = [];
    for (let i = 13; i >= 0; i--) {
      const d = new Date(now);
      d.setDate(now.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      leadsTrend.push({ date: key, count: trendMap.get(key) ?? 0 });
    }

    return {
      totalLeads,
      leadsThisWeek,
      leadsLastWeek,
      avgResponseMinutes,
      conversionRate,
      wonValue,
      openConversations,
      pendingTasks,
      leadsTrend,
      leadsByStage: stageCounts,
      leadsByTemp,
      recentActivity,
      topOperators,
    };
  }

  async getVolume(user: AuthUser) {
    return this.cached(`dash:volume:${user.tenantId}`, () => this.computeVolume(user));
  }

  private async computeVolume(user: AuthUser) {
    const last7days = new Date();
    last7days.setDate(last7days.getDate() - 7);

    // date_trunc por DIA. O groupBy anterior agrupava pelo timestamp completo
    // (created_at é único por mensagem) → devolvia uma linha POR MENSAGEM da
    // semana — milhares de linhas de payload pra um gráfico de 7 pontos.
    return this.prisma.$queryRaw<{ day: Date; count: number }[]>`
      SELECT date_trunc('day', created_at) AS day, COUNT(*)::int AS count
      FROM "Message"
      WHERE tenant_id = ${user.tenantId} AND created_at >= ${last7days}
      GROUP BY 1 ORDER BY 1 ASC`;
  }
}
