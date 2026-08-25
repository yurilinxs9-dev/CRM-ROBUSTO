import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiFeature, type Prisma } from '@prisma/client';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { LeadsService } from '../leads/leads.service';
import { isWithinBroadcastWindow } from '../broadcasts/broadcast-window';
import type { AuthUser } from '../../common/types/auth-user';
import type { AiChatMessage } from '../ai/ai.types';
import { LEAD_INSIGHTS_QUEUE, type GerarInsightJobData } from './lead-insights.queue';
import {
  extrairInsight,
  mesclarMemoria,
  montarPromptInsight,
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

    const novas = await this.prisma.message.count({
      where: { lead_id: leadId, created_at: { gt: watermark ?? new Date(0) } },
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
      select: { resumo: true, memoria: true },
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
      const pendentes = await this.prisma.message.count({
        where: { lead_id: leadId, created_at: { gt: watermark } },
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
      opts: { temperature: 0.4, maxTokens: 700 },
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
