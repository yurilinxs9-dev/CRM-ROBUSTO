import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
// `Prisma` entra como VALOR (nao `type`): `Prisma.DbNull` e usado em tempo de execucao.
import { AiFeature, LeadTemperatura, Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { LeadsService } from '../leads/leads.service';
import { buildVisibilityWhere } from '../leads/lead-visibility';
import { isWithinBroadcastWindow } from '../broadcasts/broadcast-window';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { AiChatMessage } from '../ai/ai.types';
import { LEAD_INSIGHTS_QUEUE, type GerarInsightJobData } from './lead-insights.queue';
import {
  extrairInsight,
  mesclarMemoria,
  montarPromptInsight,
  type CompraCitada,
  type InsightContexto,
  type InsightGerado,
  type MemoriaFato,
} from './insight-prompt';

const MINUTO = 60 * 1000;
const HORA = 60 * MINUTO;
const DIA = 24 * HORA;

/** Rajada de mensagens vira UM job: o gatilho espera 2min antes de rodar. */
const ATRASO_GATILHO_MS = 2 * MINUTO;
/** Sem novidade suficiente, so vale reprocessar se a ficha ja envelheceu. */
const WATERMARK_VELHO_MS = 12 * HORA;
const MSGS_PARA_DISPARAR = 5;
/** Contexto do modelo local e curto: 40 mensagens e o teto. */
const MSGS_CONTEXTO = 40;
const TENTATIVAS_JOB = 2;

const REFRESH_INTERVALO_MS = 5 * MINUTO;
/** Acima disso o Map de rate-limit e podado (processo longo, muitos leads). */
const REFRESH_MAP_MAX = 1000;

const CRON_LOTE = 50;
const CRON_ESPACAMENTO_MS = 30 * 1000;
const CRON_JANELA_ATIVIDADE_DIAS = 30;
const CRON_FICHA_VELHA_DIAS = 7;
/** Lead que nunca teve ficha so entra no cron com conversa de verdade. */
const CRON_MIN_MSGS_PRIMEIRA = 5;

/** Radar: teto por secao. Lista maior que isso ninguem trabalha num dia. */
const RADAR_CAP = 30;
/** Lead quente parado a partir daqui ja e oportunidade esfriando na mao. */
const RADAR_PROMISSOR_DIAS = 2;
const RADAR_ESFRIANDO_DIAS = 7;
/**
 * "Esperando voce": ate onde o banco procura candidatos. Cliente que mandou
 * mensagem ha mais de 30 dias e nunca foi respondido nao e uma pendencia do
 * dia — e a mesma janela de atividade que o cron de fichas usa.
 */
const RADAR_ESPERANDO_JANELA_DIAS = 30;
/** Tipado pelo enum: rename no schema quebra aqui, nao em producao. */
const RADAR_TEMPERATURAS_QUENTES: LeadTemperatura[] = [
  LeadTemperatura.QUENTE,
  LeadTemperatura.MUITO_QUENTE,
];

const TIMEZONE = 'America/Sao_Paulo';
/** Teto da busca pela proxima hora dentro da janela do tenant. */
const MAX_HORAS_BUSCA_JANELA = 7 * 24;

interface JanelaTenant {
  broadcast_window_start: number;
  broadcast_window_end: number;
  broadcast_window_days: number[];
}

/**
 * Empurra a data para a primeira hora que cai dentro da janela do tenant.
 * Sem isso, "proxima acao em 1 dia" numa sexta cairia no sabado e a tarefa
 * apareceria para o vendedor num dia em que ninguem trabalha.
 * Se em 7 dias de busca nada couber (janela mal configurada), devolve a data
 * crua — melhor uma data fora da janela do que nenhuma.
 */
export function ajustarParaJanela(base: Date, janela: JanelaTenant): Date {
  const { broadcast_window_start: inicio, broadcast_window_end: fim, broadcast_window_days: dias } = janela;
  if (!Array.isArray(dias) || dias.length === 0) return base;
  let candidata = base;
  for (let i = 0; i <= MAX_HORAS_BUSCA_JANELA; i++) {
    if (isWithinBroadcastWindow(candidata, TIMEZONE, inicio, fim, dias)) return candidata;
    candidata = new Date(candidata.getTime() + HORA);
  }
  return base;
}

/** Estreita `unknown` sem cast: objeto simples (nao array, nao null). */
function ehRegistro(valor: unknown): valor is Record<string, unknown> {
  return typeof valor === 'object' && valor !== null && !Array.isArray(valor);
}

/**
 * Json do banco -> compra tipada. Ficha antiga, string solta ou objeto sem
 * descricao viram `null`: melhor ficha sem compra do que compra quebrada na tela.
 */
export function lerCompra(valor: unknown): CompraCitada | null {
  if (!ehRegistro(valor)) return null;
  if (typeof valor.descricao !== 'string' || valor.descricao.trim() === '') return null;
  return {
    descricao: valor.descricao,
    valor: typeof valor.valor === 'number' && Number.isFinite(valor.valor) ? valor.valor : null,
    quando: typeof valor.quando === 'string' ? valor.quando : '',
  };
}

/**
 * Reais com centavos: o modelo devolve float longo (1234.5678) e o banco guarda
 * 2 casas. O sanitizador so garante que o valor e finito — 1e308 passa por ele e
 * vira `Infinity` no `* 100`, que a coluna nao aceita. Valor assim nao e preco:
 * melhor compra sem valor do que a gravacao inteira falhando.
 */
function arredondarValor(valor: number | null): number | null {
  if (valor === null) return null;
  const arredondado = Math.round(valor * 100) / 100;
  return Number.isFinite(arredondado) ? arredondado : null;
}

/**
 * O que gravar em `ultima_compra`. A compra e HISTORICO: o cliente cita uma vez
 * e as geracoes seguintes devolvem `null` — gravar esse null apagaria o dado.
 * Por isso: compra nova substitui; sem compra nova, a anterior e regravada.
 * Sem nenhuma das duas, `Prisma.DbNull` (SQL NULL da coluna nullable) — `null`
 * cru nao e aceito pelo client e `Prisma.JsonNull` gravaria o literal JSON null.
 */
function compraParaPersistir(
  nova: CompraCitada | null,
  anteriorJson: unknown,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  const compra = nova ?? lerCompra(anteriorJson);
  if (compra === null) return Prisma.DbNull;
  return {
    descricao: compra.descricao,
    valor: arredondarValor(compra.valor),
    quando: compra.quando,
  };
}

/** Json do banco -> memoria tipada. Tolera lixo (ficha antiga, escrita a mao). */
export function lerMemoria(valor: unknown): MemoriaFato[] {
  if (!Array.isArray(valor)) return [];
  const saida: MemoriaFato[] = [];
  for (const item of valor) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const registro = item as Record<string, unknown>;
    if (typeof registro.fato !== 'string' || registro.fato.trim() === '') continue;
    saida.push({
      fato: registro.fato,
      quando_dito: typeof registro.quando_dito === 'string' ? registro.quando_dito : '',
    });
  }
  return saida;
}

/**
 * Contrato do Task 3: `null` = nao veio JSON utilizavel. Reforcado aqui com o
 * resumo em branco — um JSON valido de resumo vazio apagaria uma ficha boa,
 * que e exatamente o que nunca pode acontecer.
 */
function utilizavel(insight: InsightGerado | null): insight is InsightGerado {
  return insight !== null && insight.resumo.trim() !== '';
}

/**
 * O prompt e montado por LINHA: cabecalhos de secao ("## Conversa"), campos do
 * lead e turnos da conversa. Todo texto que o CLIENTE controla — o texto da
 * mensagem, mas tambem o pushName do WhatsApp que vira `nome`, e o telefone —
 * precisa entrar achatado, senao um `\n` cria uma linha nova e forja uma secao
 * ou um turno "[data] EQUIPE:" que o atendente nunca escreveu.
 */
function achatar(texto: string): string {
  return texto.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Card do radar: tudo que a UI precisa para agir sem abrir o lead. */
export interface RadarItem {
  lead_id: string;
  nome: string;
  telefone: string;
  etapa: string;
  temperatura: string;
  ultima_interacao: Date | null;
  motivo: string;
  msg_sugerida: string;
  proxima_acao_at: Date | null;
  /** Nome de quem responde pelo lead. `null` = lead sem dono (pool). */
  responsavel: string | null;
  /** Nomes das tags, achatados: a UI so pinta chip, nao navega relacao. */
  tags: string[];
  /**
   * ISO de quando o cliente mandou a mensagem que segue sem resposta. So a fila
   * `esperando_voce` preenche — nas outras secoes o dado nao significa nada
   * (o lead pode estar respondido) e viraria "esperando ha 3 dias" mentiroso.
   */
  esperando_desde: string | null;
}

/** Os numeros do dia, para o header narrativo do radar. Zero query extra. */
export interface ResumoDia {
  esperando: number;
  chamar_hoje: number;
  /** Soma de `valor_estimado` dos cards de chamar_hoje. Sem valor conta 0. */
  valor_chamar_hoje: number;
  /** O retorno mais atrasado de hoje. `null` quando nao ha nenhum. */
  lembrete_destaque: { nome: string; motivo: string } | null;
}

export interface RadarResultado {
  resumo: ResumoDia;
  esperando_voce: RadarItem[];
  chamar_hoje: RadarItem[];
  promissores: RadarItem[];
  esfriando: RadarItem[];
}

const RADAR_SELECT = {
  id: true,
  nome: true,
  telefone: true,
  temperatura: true,
  ultima_interacao: true,
  // Vira `esperando_desde` na fila "esperando voce". A comparacao com
  // `last_agent_message_at` fica toda no banco (ver `filtroEsperando`), por isso
  // essa outra coluna nao precisa trafegar.
  last_customer_message_at: true,
  // Alimenta `resumo.valor_chamar_hoje` sem uma agregacao a mais no banco.
  valor_estimado: true,
  estagio: { select: { nome: true } },
  responsavel: { select: { nome: true } },
  // Ordem alfabetica: sem orderBy os chips trocam de lugar entre requisicoes.
  lead_tags: { select: { tag: { select: { nome: true } } }, orderBy: { tag: { nome: 'asc' } } },
  // Fonte legada de tag (ver `tagsDoLead`). Coluna da mesma linha: custo zero.
  tags: true,
  lead_insight: {
    select: { proxima_acao_at: true, proxima_acao_motivo: true, msg_sugerida: true },
  },
} as const;

type LinhaRadar = Prisma.LeadGetPayload<{ select: typeof RADAR_SELECT }>;

/**
 * O CRM tem DOIS estoques de tag e o radar precisa dos dois:
 * - a join `LeadTag -> Tag.nome`, que so a public API popula (e que espelha de
 *   volta no Json);
 * - a coluna Json `tags`, que e onde o app interno grava (tag-picker, PATCH, bulk).
 * Ler so a join deixaria quase todo lead do app interno sem chip nenhum.
 * A relacao ganha quando existe (tem id e cor); o Json e o fallback legado —
 * mesma precedencia da tabela de leads (`lead-table.tsx`).
 */
function tagsDoLead(relacao: { tag: { nome: string } }[], legado: Prisma.JsonValue): string[] {
  const daRelacao = relacao.map((lt) => lt.tag.nome);
  if (daRelacao.length > 0) return daRelacao;
  // Json cru: nada no banco impede numero, null, objeto ou string vazia no
  // meio da lista (mesma defesa de `lerCompra`/`lerMemoria`).
  if (!Array.isArray(legado)) return [];
  return legado.filter((t): t is string => typeof t === 'string' && t.trim() !== '');
}

/** Dias inteiros parados. `null` = lead que nunca teve interacao registrada. */
function diasParado(ultima: Date | null, agora: number): number | null {
  if (ultima === null) return null;
  return Math.floor((agora - ultima.getTime()) / DIA);
}

/**
 * Motivo quando a ficha nao tem um (lead sem insight, ou insight sem motivo).
 * Sem acento, como o resto das mensagens do modulo.
 */
function motivoDerivado(dias: number | null, quente: boolean): string {
  const prefixo = quente ? 'QUENTE ' : '';
  if (dias === null) return `${prefixo}sem contato registrado`;
  return `${prefixo}sem contato ha ${dias} dia${dias === 1 ? '' : 's'}`;
}

function montarRadarItem(linha: LinhaRadar, agora: number, esperando: boolean): RadarItem {
  const quente = RADAR_TEMPERATURAS_QUENTES.includes(linha.temperatura);
  const motivoFicha = linha.lead_insight?.proxima_acao_motivo.trim() ?? '';
  return {
    lead_id: linha.id,
    nome: linha.nome,
    telefone: linha.telefone,
    etapa: linha.estagio?.nome ?? 'sem etapa',
    temperatura: String(linha.temperatura),
    ultima_interacao: linha.ultima_interacao,
    motivo:
      motivoFicha !== ''
        ? motivoFicha
        : motivoDerivado(diasParado(linha.ultima_interacao, agora), quente),
    msg_sugerida: linha.lead_insight?.msg_sugerida ?? '',
    proxima_acao_at: linha.lead_insight?.proxima_acao_at ?? null,
    responsavel: linha.responsavel?.nome ?? null,
    tags: tagsDoLead(linha.lead_tags, linha.tags),
    esperando_desde:
      esperando && linha.last_customer_message_at !== null
        ? linha.last_customer_message_at.toISOString()
        : null,
  };
}

/**
 * Decimal do Prisma nao soma sozinho; lead sem valor conta zero. O arredondamento
 * no fim e obrigatorio: a coluna guarda 2 casas, mas somar em float devolve
 * 0.30000000000000004 para 0.10 + 0.20 — e esse numero chegaria cru na tela.
 */
function somarValor(linhas: LinhaRadar[]): number {
  const total = linhas.reduce((soma, l) => soma + (l.valor_estimado?.toNumber() ?? 0), 0);
  return Math.round(total * 100) / 100;
}

/**
 * Ficha inteligente do lead: enfileira, gera pelo LLM e serve para a UI.
 * Toda geracao passa pela fila (regra 1 do projeto: nada de LLM sincrono no
 * caminho do webhook).
 */
@Injectable()
export class LeadInsightsService {
  private readonly logger = new Logger(LeadInsightsService.name);
  /** leadId -> timestamp do ultimo refresh manual (rate limit por lead). */
  private readonly ultimoRefresh = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(LEAD_INSIGHTS_QUEUE) private readonly queue: Queue<GerarInsightJobData>,
    private readonly ai: AiProviderService,
    private readonly leads: LeadsService,
  ) {}

  /**
   * Chamado pelo inbound a cada mensagem do cliente. So enfileira quando
   * ha novidade que justifique gastar o modelo: >=5 mensagens novas desde a
   * ultima geracao, OU >=1 se a ficha ja passou de 12h.
   */
  async enfileirarSeElegivel(leadId: string, tenantId: string): Promise<boolean> {
    const anterior = await this.prisma.leadInsight.findUnique({
      where: { lead_id: leadId },
      select: { ultima_msg_processada_at: true },
    });
    const watermark = anterior?.ultima_msg_processada_at ?? null;

    // Nota interna e a equipe falando com ela mesma: nao e novidade do cliente
    // e nao pode disparar (nem gastar) uma geracao do modelo.
    const novas = await this.prisma.message.count({
      where: {
        lead_id: leadId,
        is_internal_note: false,
        created_at: { gt: watermark ?? new Date(0) },
      },
    });
    if (novas === 0) return false;

    const fichaVelha = watermark === null || Date.now() - watermark.getTime() > WATERMARK_VELHO_MS;
    if (novas < MSGS_PARA_DISPARAR && !fichaVelha) return false;

    await this.enfileirar(leadId, tenantId, `lead-${leadId}`, ATRASO_GATILHO_MS);
    return true;
  }

  private async enfileirar(
    leadId: string,
    tenantId: string,
    jobId: string,
    delay: number,
  ): Promise<void> {
    await this.queue.add(
      'gerar',
      { leadId, tenantId },
      { jobId, delay, attempts: TENTATIVAS_JOB },
    );
  }

  /** Ficha do lead para a UI. O acesso e o MESMO do detalhe do lead. */
  async obter(leadId: string, user: AuthUser) {
    await this.leads.findOne(leadId, user);
    return this.prisma.leadInsight.findUnique({ where: { lead_id: leadId } });
  }

  /** Regeracao manual. Rate limit por lead: 1 a cada 5 minutos. */
  async refrescar(leadId: string, user: AuthUser): Promise<{ ok: true; enfileirado: boolean }> {
    await this.leads.findOne(leadId, user);

    const agora = Date.now();
    const ultimo = this.ultimoRefresh.get(leadId);
    if (ultimo !== undefined && agora - ultimo < REFRESH_INTERVALO_MS) {
      throw new HttpException(
        'Ficha atualizada ha pouco. Tente novamente em alguns minutos.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    // jobId proprio: um gatilho automatico ja agendado (delay de 2min) nao pode
    // engolir o pedido manual, que precisa rodar agora.
    // O relogio so e marcado DEPOIS do enfileiramento: se o Redis recusar, o
    // usuario nao fica 5 minutos travado por um clique que nao gerou nada.
    await this.enfileirar(leadId, user.tenantId, `refresh-${leadId}`, 0);
    this.podarRefresh(agora);
    this.ultimoRefresh.set(leadId, agora);
    return { ok: true, enfileirado: true };
  }

  /**
   * Radar comercial: a fila de trabalho do vendedor em 4 secoes.
   * - esperando_voce: o cliente falou por ultimo e ninguem respondeu.
   * - chamar_hoje: a ficha marcou uma proxima acao que ja venceu.
   * - promissores: lead quente que parou de conversar.
   * - esfriando: qualquer lead ativo parado ha uma semana.
   * Um lead aparece UMA vez so, na secao mais urgente
   * (esperando_voce > chamar_hoje > promissores > esfriando) — a mesma pessoa
   * em quatro listas seria trabalho repetido, e cliente sem resposta e sempre a
   * pendencia mais urgente que existe. Estagio ganho/perdido nunca entra:
   * negocio fechado ou morto nao e tarefa.
   * `pipelineId` opcional recorta TODAS as filas por funil (ausente = todos).
   */
  async radar(user: AuthUser, pipelineId?: string): Promise<RadarResultado> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { pool_enabled: true },
    });
    const base: Record<string, unknown> = {
      tenant_id: user.tenantId,
      estagio: { is_won: false, is_lost: false },
    };
    // Chave disjunta da visibilidade (que so escreve `OR`/`responsavel_id`):
    // o funil recorta as 4 filas sem nunca comer o recorte de quem ve o que.
    if (pipelineId !== undefined) base.pipeline_id = pipelineId;
    Object.assign(
      base,
      buildVisibilityWhere({
        userId: user.id,
        role: user.role as UserRole,
        poolEnabled: Boolean(tenant?.pool_enabled),
      }),
    );

    const agora = Date.now();
    const [vencidos, quentes, parados, esperandoAgora] = await Promise.all([
      this.buscarRadar(
        { ...base, lead_insight: { proxima_acao_at: { lte: new Date(agora) } } },
        // Mais atrasado primeiro: a acao vencida ha mais tempo e a mais urgente.
        { lead_insight: { proxima_acao_at: 'asc' } },
      ),
      this.buscarRadar(
        {
          ...base,
          temperatura: { in: RADAR_TEMPERATURAS_QUENTES },
          ultima_interacao: { lte: new Date(agora - RADAR_PROMISSOR_DIAS * DIA) },
        },
        { ultima_interacao: 'asc' },
      ),
      this.buscarRadar(
        { ...base, ultima_interacao: { lte: new Date(agora - RADAR_ESFRIANDO_DIAS * DIA) } },
        { ultima_interacao: 'asc' },
      ),
      this.buscarRadar(
        { ...base, ...this.filtroEsperando(agora) },
        // Quem espera ha mais tempo primeiro.
        { last_customer_message_at: 'asc' },
      ),
    ]);

    // O dedupe so marca quem VIROU card: um candidato descartado pelo filtro em
    // memoria nao pode roubar a vaga do proprio lead em chamar_hoje.
    const vistos = new Set<string>();
    const selecionar = (linhas: LinhaRadar[]): LinhaRadar[] => {
      const saida: LinhaRadar[] = [];
      for (const linha of linhas) {
        if (saida.length >= RADAR_CAP) break;
        if (vistos.has(linha.id)) continue;
        vistos.add(linha.id);
        saida.push(linha);
      }
      return saida;
    };

    // Ordem das chamadas = precedencia do dedupe, nao a ordem das queries.
    const linhasEsperando = selecionar(esperandoAgora);
    const linhasChamarHoje = selecionar(vencidos);
    const linhasPromissores = selecionar(quentes);
    const linhasEsfriando = selecionar(parados);

    const esperando_voce = linhasEsperando.map((l) => montarRadarItem(l, agora, true));
    const chamar_hoje = linhasChamarHoje.map((l) => montarRadarItem(l, agora, false));

    return {
      // Contado do que a UI de fato recebe (pos-dedupe, pos-cap), nunca do que
      // o banco devolveu: numero do header que nao bate com a lista abaixo dele
      // e pior do que nao ter header.
      resumo: {
        esperando: esperando_voce.length,
        chamar_hoje: chamar_hoje.length,
        valor_chamar_hoje: somarValor(linhasChamarHoje),
        // O mais atrasado da fila e o lembrete que o vendedor precisa ver.
        lembrete_destaque:
          chamar_hoje.length > 0
            ? { nome: chamar_hoje[0].nome, motivo: chamar_hoje[0].motivo }
            : null,
      },
      esperando_voce,
      chamar_hoje,
      promissores: linhasPromissores.map((l) => montarRadarItem(l, agora, false)),
      esfriando: linhasEsfriando.map((l) => montarRadarItem(l, agora, false)),
    };
  }

  /**
   * Recorte da fila "esperando voce", inteiro no BANCO: o cliente mandou
   * mensagem recente e a equipe ainda nao respondeu.
   *
   * "Ainda nao respondeu" compara COLUNA COM COLUNA, e isso se resolve com
   * field reference do Prisma (`prisma.lead.fields.*`, disponivel desde a 4.5).
   * A alternativa que parece obvia — buscar um lote e filtrar em memoria — e
   * furada e nao apenas lenta: o lote vem ordenado por quem espera ha mais
   * tempo, ou seja, pelos candidatos com MAIS chance de ja terem sido
   * respondidos. Num tenant com movimento normal o lote inteiro seria descartado
   * e a fila apareceria vazia com clientes esperando de verdade no banco.
   *
   * O `OR` da secao vai aninhado dentro de `AND` de proposito: escrito no topo,
   * ele sobrescreveria em silencio o `OR` de visibilidade que
   * `buildVisibilityWhere` espalha no `base` — vazando lead de outro operador
   * com a suite verde. `AND` e uma chave que a visibilidade nunca escreve.
   *
   * `last_agent_message_at: null` precisa estar explicito: em SQL,
   * `null < data` e null, nao verdadeiro — sem esse ramo, o lead que a equipe
   * NUNCA respondeu (o mais urgente que existe) ficaria de fora.
   *
   * Empate no milissegundo conta como respondido (`lt`, nao `lte`): fila de
   * trabalho erra melhor para menos do que cobrando retorno ja dado.
   *
   * Tipado como `Prisma.LeadWhereInput`, e nao inline no `findMany`: o `where`
   * do radar trafega como `Record<string, unknown>`, entao um nome de coluna
   * errado passaria pelo compilador E pelos testes (o Prisma e mockado) e so
   * quebraria em producao. Aqui o compilador confere coluna e formato.
   */
  private filtroEsperando(agora: number): Prisma.LeadWhereInput {
    return {
      last_customer_message_at: {
        not: null,
        gte: new Date(agora - RADAR_ESPERANDO_JANELA_DIAS * DIA),
      },
      AND: [
        {
          OR: [
            { last_agent_message_at: null },
            { last_agent_message_at: { lt: this.prisma.lead.fields.last_customer_message_at } },
          ],
        },
      ],
    };
  }

  private buscarRadar(
    where: Record<string, unknown>,
    orderBy: Prisma.LeadOrderByWithRelationInput,
  ): Promise<LinhaRadar[]> {
    return this.prisma.lead.findMany({ where, select: RADAR_SELECT, orderBy, take: RADAR_CAP });
  }

  private podarRefresh(agora: number): void {
    if (this.ultimoRefresh.size < REFRESH_MAP_MAX) return;
    for (const [lead, quando] of this.ultimoRefresh) {
      if (agora - quando >= REFRESH_INTERVALO_MS) this.ultimoRefresh.delete(lead);
    }
  }

  /**
   * Worker: monta o contexto, chama o modelo e grava a ficha.
   * Nunca lanca por resposta ruim do modelo — job com falha ficaria em retry
   * infinito por causa de um 3B teimoso. Falha de parse = mantem a ficha atual.
   */
  async gerarInsight(leadId: string, tenantId: string): Promise<void> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: {
        id: true,
        nome: true,
        telefone: true,
        temperatura: true,
        valor_estimado: true,
        ultima_interacao: true,
        estagio: { select: { nome: true } },
        tenant: {
          select: {
            broadcast_window_start: true,
            broadcast_window_end: true,
            broadcast_window_days: true,
          },
        },
      },
    });
    if (!lead) {
      this.logger.warn(`Insight ignorado: lead ${leadId} nao existe no tenant ${tenantId}`);
      return;
    }

    const recentes = await this.prisma.message.findMany({
      where: { lead_id: leadId, is_internal_note: false },
      orderBy: { created_at: 'desc' },
      take: MSGS_CONTEXTO,
      select: { direction: true, type: true, content: true, created_at: true },
    });
    if (recentes.length === 0) return;
    const mensagens = [...recentes].reverse();

    const anterior = await this.prisma.leadInsight.findUnique({
      where: { lead_id: leadId },
      // `ultima_compra` entra no select porque a ficha anterior e a fonte quando o
      // modelo nao cita compra nenhuma nesta geracao.
      select: { resumo: true, memoria: true, ultima_compra: true },
    });

    const contexto: InsightContexto = {
      lead: {
        nome: achatar(lead.nome),
        telefone: achatar(lead.telefone),
        etapa: lead.estagio?.nome ?? 'sem etapa',
        temperatura: String(lead.temperatura),
        // Decimal do Prisma nao serializa como numero sozinho.
        valor_estimado: lead.valor_estimado === null ? null : lead.valor_estimado.toNumber(),
        ultima_interacao: lead.ultima_interacao,
      },
      insightAnterior: anterior
        ? { resumo: anterior.resumo, memoria: lerMemoria(anterior.memoria) }
        : null,
      mensagens: mensagens.map((m) => ({
        de: m.direction === 'INCOMING' ? ('cliente' as const) : ('equipe' as const),
        texto: achatar(m.content ?? `[${String(m.type)}]`),
        em: m.created_at,
      })),
    };

    const prompt = montarPromptInsight(contexto);
    let insight = await this.pedirInsight(prompt, tenantId, leadId);
    if (!utilizavel(insight)) {
      const reforco: AiChatMessage[] = [
        ...prompt,
        { role: 'user', content: 'Responda SOMENTE o objeto JSON.' },
      ];
      insight = await this.pedirInsight(reforco, tenantId, leadId);
    }
    if (!utilizavel(insight)) {
      this.logger.warn(
        `Insight do lead ${leadId}: modelo nao devolveu JSON utilizavel em 2 tentativas — ficha anterior mantida`,
      );
      return;
    }

    const memoria = mesclarMemoria(
      anterior ? lerMemoria(anterior.memoria) : [],
      insight.memoria_novos_fatos,
    );
    const proximaAcao = ajustarParaJanela(
      new Date(Date.now() + insight.proxima_acao_em_dias * DIA),
      lead.tenant,
    );
    const watermark = mensagens[mensagens.length - 1].created_at;

    const campos = {
      resumo: insight.resumo,
      memoria: memoria as unknown as Prisma.InputJsonValue,
      proxima_acao_at: proximaAcao,
      proxima_acao_motivo: insight.proxima_acao_motivo,
      msg_sugerida: insight.msg_sugerida,
      nota_atendimento: insight.nota_atendimento,
      nota_ponto_forte: insight.nota_ponto_forte,
      nota_ponto_melhoria: insight.nota_ponto_melhoria,
      ultima_compra: compraParaPersistir(insight.ultima_compra, anterior?.ultima_compra),
      ultima_msg_processada_at: watermark,
    };

    // Upsert pelo client (nao SQL cru): `updated_at` nao tem default no banco,
    // quem preenche e o Prisma.
    await this.prisma.leadInsight.upsert({
      where: { lead_id: leadId },
      create: { tenant_id: tenantId, lead_id: leadId, ...campos, geracoes: 1 },
      update: { ...campos, geracoes: { increment: 1 } },
    });

    await this.rechecarNovidade(leadId, tenantId, watermark);
  }

  /**
   * Mensagem que chegou ENQUANTO este job rodava (o modelo local leva de 30s a
   * 2min) perde o gatilho: o `queue.add` do inbound e descartado porque o jobId
   * `lead-<id>` ainda existe — o job esta ACTIVE, nao so delayed. Sem esta
   * reconferencia pos-upsert, a ultima mensagem do cliente ficaria fora da ficha
   * ate a proxima mensagem ou ate o cron de 7 dias.
   */
  private async rechecarNovidade(
    leadId: string,
    tenantId: string,
    watermark: Date,
  ): Promise<void> {
    try {
      // Mesmo recorte do gatilho: nota interna nao conta como novidade.
      const pendentes = await this.prisma.message.count({
        where: { lead_id: leadId, is_internal_note: false, created_at: { gt: watermark } },
      });
      if (pendentes === 0) return;
      // jobId NAO pode ser `lead-<id>`: e o do job que esta rodando agora, e o
      // add cairia no mesmo buraco. O watermark deixa o id unico por geracao.
      await this.enfileirar(
        leadId,
        tenantId,
        `lead-${leadId}-${watermark.getTime()}`,
        ATRASO_GATILHO_MS,
      );
      this.logger.log(
        `Insight do lead ${leadId}: ${pendentes} msg(s) chegaram durante a geracao — re-enfileirado`,
      );
    } catch (err) {
      this.logger.warn(`Recheque de novidade do lead ${leadId} falhou: ${String(err)}`);
    }
  }

  private async pedirInsight(
    messages: AiChatMessage[],
    tenantId: string,
    leadId: string,
  ): Promise<InsightGerado | null> {
    const resposta = await this.ai.chat({
      feature: AiFeature.insights,
      messages,
      tenantId,
      leadId,
      // 900 (era 700): a resposta agora tem 9 chaves — com nota, os dois pontos do
      // atendimento e a compra, 700 tokens cortavam o JSON no meio.
      opts: { temperature: 0.4, maxTokens: 900 },
    });
    return extrairInsight(resposta.text);
  }

  /**
   * Varredura diaria: leads vivos (mensagem nos ultimos 30 dias) cuja ficha
   * passou de 7 dias — ou que nunca tiveram ficha e ja tem conversa de verdade.
   * Os jobs saem espacados em 30s para nao entupir o modelo local de uma vez.
   */
  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: TIMEZONE })
  async varrerLeadsParados(): Promise<number> {
    const agora = Date.now();
    const desdeAtividade = new Date(agora - CRON_JANELA_ATIVIDADE_DIAS * DIA);
    const fichaVelha = new Date(agora - CRON_FICHA_VELHA_DIAS * DIA);

    // O corte de ">=5 mensagens" nao existe como filtro no Prisma (nao ha where
    // por _count), entao busca-se um multiplo do lote e filtra-se em memoria.
    const candidatos = await this.prisma.lead.findMany({
      where: {
        messages: { some: { created_at: { gte: desdeAtividade } } },
        OR: [{ lead_insight: { is: null } }, { lead_insight: { updated_at: { lt: fichaVelha } } }],
      },
      select: {
        id: true,
        tenant_id: true,
        lead_insight: { select: { updated_at: true } },
        _count: { select: { messages: true } },
      },
      orderBy: { ultima_interacao: 'desc' },
      take: CRON_LOTE * 4,
    });

    const elegiveis = candidatos
      .filter((l) => l.lead_insight !== null || l._count.messages >= CRON_MIN_MSGS_PRIMEIRA)
      .slice(0, CRON_LOTE);

    let enfileirados = 0;
    for (const [i, lead] of elegiveis.entries()) {
      try {
        await this.enfileirar(lead.id, lead.tenant_id, `lead-${lead.id}`, i * CRON_ESPACAMENTO_MS);
        enfileirados++;
      } catch (err) {
        this.logger.warn(`Cron de insights: falha ao enfileirar lead ${lead.id}: ${String(err)}`);
      }
    }
    if (enfileirados > 0) {
      this.logger.log(`Cron de insights: ${enfileirados} leads enfileirados para regeracao`);
    }
    return enfileirados;
  }
}
