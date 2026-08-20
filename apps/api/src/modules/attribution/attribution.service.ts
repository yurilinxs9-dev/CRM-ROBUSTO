import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { AdReferral } from '../webhooks/ad-referral';
import { classifyAttribution } from './attribution-classify';
import {
  attributionInputSchema,
  campaignLabelSchema,
  reportQuerySchema,
  trackQuerySchema,
  type AttributionInput,
} from './attribution.types';

/**
 * Marcador que viaja no texto pré-preenchido do wa.me. Fica aqui, em UM lugar,
 * porque o snippet do site o escreve e o inbound o lê — se as duas pontas
 * divergirem, o clique some sem erro nenhum.
 */
export const CLICK_CODE_PATTERN = /\(ref:\s*([A-Za-z0-9]{4,16})\)/i;

const ANALYTICS_TTL = 60; // segundos, igual ao AnalyticsService

// Mesma âncora de fuso do AnalyticsService (BRT, sem DST desde 2019). Copiada
// de propósito em vez de importada: não vale acoplar dois módulos por 15 linhas
// de aritmética de data. Se um dia divergirem, é aqui que se olha.
const DAY_MS = 24 * 60 * 60 * 1000;
const TZ_OFFSET = '-03:00';

function defaultRange(from?: string, to?: string): { from: Date; to: Date } {
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/;
  const toDate =
    to && dateOnly.test(to)
      ? new Date(`${to}T23:59:59.999${TZ_OFFSET}`)
      : to
        ? new Date(to)
        : new Date();
  const fromDate =
    from && dateOnly.test(from)
      ? new Date(`${from}T00:00:00.000${TZ_OFFSET}`)
      : from
        ? new Date(from)
        : new Date(toDate.getTime() - 30 * DAY_MS);
  return { from: fromDate, to: toDate };
}

const round2 = (v: number): number => Number(v.toFixed(2));

interface AggRow {
  leads: bigint;
  won: bigint;
  lost: bigint;
  won_value: number;
}

interface ChannelRow extends AggRow {
  channel: string;
  paid: boolean;
}

interface CampaignRow extends AggRow {
  source: string | null;
  campaign_id: string;
  campaign_name: string | null;
}

interface KeywordRow extends AggRow {
  keyword: string;
}

export interface AttributionBucket {
  leads: number;
  won: number;
  lost: number;
  won_value: number;
  conversion_rate: number;
}

/** Converte a linha crua do agregado no formato que o frontend consome. */
function toBucket(row: AggRow): AttributionBucket {
  const won = Number(row.won);
  const lost = Number(row.lost);
  const fechados = won + lost;
  return {
    leads: Number(row.leads),
    won,
    lost,
    won_value: round2(Number(row.won_value ?? 0)),
    conversion_rate: fechados > 0 ? Number((won / fechados).toFixed(4)) : 0,
  };
}

@Injectable()
export class AttributionService {
  private readonly logger = new Logger(AttributionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: RedisCacheService,
  ) {}

  // -------------------------------------------------------------------------
  // Gravação (first-touch)
  // -------------------------------------------------------------------------

  /**
   * Grava a origem do lead. Idempotente por construção: a unique em `lead_id`
   * faz o segundo toque falhar, e falhar aqui é o comportamento certo — quem
   * trouxe a pessoa foi o primeiro clique, não o último.
   *
   * NUNCA lança. É chamada de dentro do pipeline de inbound e da API pública;
   * atribuição é métrica, e métrica não pode derrubar atendimento.
   */
  async recordFirstTouch(leadId: string, tenantId: string, input: unknown): Promise<void> {
    try {
      const parsed = attributionInputSchema.safeParse(input);
      if (!parsed.success) return;

      const norm = classifyAttribution(parsed.data);
      await this.prisma.leadAttribution.create({
        data: { lead_id: leadId, tenant_id: tenantId, ...norm },
      });
    } catch (err) {
      // P2002 = já existe atribuição para este lead. É o caminho esperado
      // quando um cliente antigo clica num anúncio novo: o first-touch vence.
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') return;
      this.logger.warn(`recordFirstTouch(${leadId}): ${String(err)}`);
    }
  }

  /** Traduz o anúncio do WhatsApp (Click to WhatsApp) para a entrada comum. */
  fromAdReferral(ad: AdReferral): AttributionInput {
    return {
      ad_id: ad.source_id,
      ad_title: ad.title,
      ad_url: ad.source_url,
      ctwa_clid: ad.ctwa_clid,
      source_app: ad.source_app,
    };
  }

  /** Acha o código do clique no texto da primeira mensagem. */
  extractClickCode(text: string | null | undefined): string | null {
    if (!text) return null;
    const m = CLICK_CODE_PATTERN.exec(text);
    return m ? m[1] : null;
  }

  /**
   * Troca o código pelo payload do clique e marca o clique como consumido.
   * Devolve `null` quando o código não existe (código digitado errado, clique
   * de outro tenant, clique já expirado da poda).
   */
  async consumeClick(tenantId: string, code: string): Promise<AttributionInput | null> {
    try {
      const click = await this.prisma.trackedClick.findUnique({
        where: { tenant_id_code: { tenant_id: tenantId, code } },
      });
      if (!click) return null;

      const parsed = attributionInputSchema.safeParse(click.payload);
      if (!parsed.success) return null;

      if (!click.consumed_at) {
        await this.prisma.trackedClick
          .update({ where: { id: click.id }, data: { consumed_at: new Date() } })
          .catch(() => undefined);
      }
      return { ...parsed.data, clicked_at: click.clicked_at };
    } catch (err) {
      this.logger.warn(`consumeClick(${code}): ${String(err)}`);
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Pixel do site
  // -------------------------------------------------------------------------

  /**
   * Registra o clique vindo do snippet. Silencioso por natureza: o navegador
   * recebe um GIF de 1x1 aconteça o que acontecer, então erro aqui nunca vira
   * erro visível na página do cliente.
   */
  async registerClick(query: unknown): Promise<void> {
    const parsed = trackQuerySchema.safeParse(query);
    if (!parsed.success) return;
    const q = parsed.data;

    const site = await this.prisma.tenantSiteConfig.findUnique({
      where: { site_token: q.t },
    });
    if (!site) return;

    // Sem código não há o que casar depois — é visita, não clique rastreável.
    if (!q.k) return;

    const payload: AttributionInput = {
      gclid: q.gclid,
      wbraid: q.wbraid,
      gbraid: q.gbraid,
      fbclid: q.fbclid,
      utm_source: q.utm_source,
      utm_medium: q.utm_medium,
      utm_campaign: q.utm_campaign,
      utm_term: q.utm_term,
      utm_content: q.utm_content,
      campaignid: q.campaignid,
      adgroupid: q.adgroupid,
      creative: q.creative,
      keyword: q.keyword,
      matchtype: q.matchtype,
      network: q.network,
      device: q.device,
      landing_url: q.lp ?? q.landing_url,
      referrer: q.rf ?? q.referrer,
    };

    const clickedAt = q.ts ? new Date(q.ts) : new Date();

    await this.prisma.trackedClick
      .upsert({
        where: { tenant_id_code: { tenant_id: site.tenant_id, code: q.k } },
        create: {
          tenant_id: site.tenant_id,
          code: q.k,
          payload: payload as Prisma.InputJsonObject,
          clicked_at: clickedAt,
        },
        // Reenvio do mesmo código (usuário recarregou a página) não reescreve
        // o clique original — first-touch também aqui.
        update: {},
      })
      .catch((err) => this.logger.warn(`registerClick: ${String(err)}`));
  }

  /**
   * Poda dos cliques. TrackedClick é tabela de passagem: ou o clique vira
   * atribuição num lead, ou não vira nada. 120 dias dá folga sobre os 90 do
   * cookie de first-touch e evita crescimento sem fim.
   *
   * Só toca na tabela desta feature — nenhum dado de lead, mensagem ou
   * atribuição já gravada é afetado. Horário escolhido para não colidir com a
   * poda de webhooks (3h30) nem com a de metadata (3h45).
   */
  @Cron('15 4 * * *')
  async pruneOldClicks(): Promise<void> {
    const cutoff = new Date(Date.now() - 120 * DAY_MS);
    try {
      const { count } = await this.prisma.trackedClick.deleteMany({
        where: { created_at: { lt: cutoff } },
      });
      if (count > 0) this.logger.log(`Poda de cliques: ${count} removidos (>120 dias)`);
    } catch (err) {
      this.logger.warn(`pruneOldClicks: ${String(err)}`);
    }
  }

  // -------------------------------------------------------------------------
  // Configuração do site (token público)
  // -------------------------------------------------------------------------

  /** Token público do tenant, criado na primeira visita à aba de rastreamento. */
  async getSiteToken(tenantId: string): Promise<string> {
    const existing = await this.prisma.tenantSiteConfig.findUnique({
      where: { tenant_id: tenantId },
    });
    if (existing) return existing.site_token;

    const token = randomBytes(16).toString('base64url');
    const criado = await this.prisma.tenantSiteConfig.upsert({
      where: { tenant_id: tenantId },
      create: { tenant_id: tenantId, site_token: token },
      update: {},
    });
    return criado.site_token;
  }

  // -------------------------------------------------------------------------
  // Relatório
  // -------------------------------------------------------------------------

  /**
   * Recorte de visibilidade. Mesma regra do AnalyticsService: OPERADOR só vê
   * os leads dos quais é responsável.
   */
  private scopeSql(user: AuthUser): Prisma.Sql {
    return user.role === UserRole.OPERADOR
      ? Prisma.sql`AND l.responsavel_id = ${user.id}`
      : Prisma.empty;
  }

  /**
   * Resumo por canal + total do período. O "não identificado" NÃO é uma linha
   * gravada: é a diferença entre os leads do período e os leads com atribuição.
   * Assim o inbound comum (mensagem sem anúncio e sem código) não paga um
   * INSERT por lead só para engordar um bucket que já sai por subtração.
   */
  async getSummary(user: AuthUser, query: unknown) {
    const { from: rawFrom, to: rawTo } = reportQuerySchema.parse(query);
    const { from, to } = defaultRange(rawFrom, rawTo);
    const tenantId = user.tenantId;

    const cacheKey = `attribution:summary:${tenantId}:${user.role}:${user.id}:${from.getTime()}:${to.getTime()}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    const scope = this.scopeSql(user);

    const [rows, totals] = await Promise.all([
      this.prisma.$queryRaw<ChannelRow[]>`
        SELECT a.channel::text AS channel,
               a.paid AS paid,
               count(*)::bigint AS leads,
               count(*) FILTER (WHERE s.is_won)::bigint AS won,
               count(*) FILTER (WHERE s.is_lost)::bigint AS lost,
               COALESCE(sum(l.valor_estimado) FILTER (WHERE s.is_won), 0)::float8 AS won_value
          FROM "LeadAttribution" a
          JOIN "Lead" l ON l.id = a.lead_id
          JOIN "Stage" s ON s.id = l.estagio_id
         WHERE a.tenant_id = ${tenantId}
           AND l.created_at >= ${from}
           AND l.created_at <= ${to}
           ${scope}
         GROUP BY a.channel, a.paid
         ORDER BY leads DESC
      `,
      this.prisma.$queryRaw<AggRow[]>`
        SELECT count(*)::bigint AS leads,
               count(*) FILTER (WHERE s.is_won)::bigint AS won,
               count(*) FILTER (WHERE s.is_lost)::bigint AS lost,
               COALESCE(sum(l.valor_estimado) FILTER (WHERE s.is_won), 0)::float8 AS won_value
          FROM "Lead" l
          JOIN "Stage" s ON s.id = l.estagio_id
         WHERE l.tenant_id = ${tenantId}
           AND l.created_at >= ${from}
           AND l.created_at <= ${to}
           ${scope}
      `,
    ]);

    const total = toBucket(totals[0] ?? { leads: 0n, won: 0n, lost: 0n, won_value: 0 });

    const channels = rows.map((r) => ({
      channel: r.channel,
      paid: r.paid,
      ...toBucket(r),
    }));

    const atribuidos = channels.reduce((acc, c) => acc + c.leads, 0);
    const naoIdentificados = Math.max(total.leads - atribuidos, 0);
    if (naoIdentificados > 0) {
      const jaExiste = channels.find((c) => c.channel === 'UNKNOWN');
      if (jaExiste) {
        jaExiste.leads += naoIdentificados;
      } else {
        channels.push({
          channel: 'UNKNOWN',
          paid: false,
          leads: naoIdentificados,
          won: 0,
          lost: 0,
          won_value: 0,
          conversion_rate: 0,
        });
      }
    }

    channels.sort((a, b) => b.leads - a.leads);

    const pagos = channels.filter((c) => c.paid);
    const paidLeads = pagos.reduce((acc, c) => acc + c.leads, 0);

    const result = {
      period: { from: from.toISOString(), to: to.toISOString() },
      total,
      channels,
      paid: {
        leads: paidLeads,
        share: total.leads > 0 ? Number((paidLeads / total.leads).toFixed(4)) : 0,
        won: pagos.reduce((acc, c) => acc + c.won, 0),
        won_value: round2(pagos.reduce((acc, c) => acc + c.won_value, 0)),
      },
    };

    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  /**
   * Campanhas e palavras-chave. O rótulo amigável vem do AdCampaignLabel — é
   * o que substitui a API do Google: o ID continua sendo a chave, e o nome é
   * escrito uma vez pelo usuário.
   */
  async getCampaigns(user: AuthUser, query: unknown) {
    const { from: rawFrom, to: rawTo } = reportQuerySchema.parse(query);
    const { from, to } = defaultRange(rawFrom, rawTo);
    const tenantId = user.tenantId;

    const cacheKey = `attribution:campaigns:${tenantId}:${user.role}:${user.id}:${from.getTime()}:${to.getTime()}`;
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    const scope = this.scopeSql(user);

    const [campanhas, keywords, labels] = await Promise.all([
      this.prisma.$queryRaw<CampaignRow[]>`
        SELECT a.source AS source,
               a.campaign_id AS campaign_id,
               max(a.campaign_name) AS campaign_name,
               count(*)::bigint AS leads,
               count(*) FILTER (WHERE s.is_won)::bigint AS won,
               count(*) FILTER (WHERE s.is_lost)::bigint AS lost,
               COALESCE(sum(l.valor_estimado) FILTER (WHERE s.is_won), 0)::float8 AS won_value
          FROM "LeadAttribution" a
          JOIN "Lead" l ON l.id = a.lead_id
          JOIN "Stage" s ON s.id = l.estagio_id
         WHERE a.tenant_id = ${tenantId}
           AND a.campaign_id IS NOT NULL
           AND l.created_at >= ${from}
           AND l.created_at <= ${to}
           ${scope}
         GROUP BY a.source, a.campaign_id
         ORDER BY leads DESC
         LIMIT 100
      `,
      this.prisma.$queryRaw<KeywordRow[]>`
        SELECT a.keyword AS keyword,
               count(*)::bigint AS leads,
               count(*) FILTER (WHERE s.is_won)::bigint AS won,
               count(*) FILTER (WHERE s.is_lost)::bigint AS lost,
               COALESCE(sum(l.valor_estimado) FILTER (WHERE s.is_won), 0)::float8 AS won_value
          FROM "LeadAttribution" a
          JOIN "Lead" l ON l.id = a.lead_id
          JOIN "Stage" s ON s.id = l.estagio_id
         WHERE a.tenant_id = ${tenantId}
           AND a.keyword IS NOT NULL
           AND l.created_at >= ${from}
           AND l.created_at <= ${to}
           ${scope}
         GROUP BY a.keyword
         ORDER BY leads DESC
         LIMIT 50
      `,
      this.prisma.adCampaignLabel.findMany({ where: { tenant_id: tenantId } }),
    ]);

    const labelDe = new Map(labels.map((l) => [`${l.source}:${l.campaign_id}`, l.label]));

    const result = {
      period: { from: from.toISOString(), to: to.toISOString() },
      campaigns: campanhas.map((c) => {
        const source = c.source ?? 'unknown';
        return {
          source,
          campaign_id: c.campaign_id,
          // Ordem de preferência: nome dado pelo usuário → nome que veio na UTM
          // → o ID cru, que é sempre melhor do que campo vazio.
          label: labelDe.get(`${source}:${c.campaign_id}`) ?? c.campaign_name ?? c.campaign_id,
          has_custom_label: labelDe.has(`${source}:${c.campaign_id}`),
          ...toBucket(c),
        };
      }),
      keywords: keywords.map((k) => ({ keyword: k.keyword, ...toBucket(k) })),
    };

    await this.cache.set(cacheKey, result, ANALYTICS_TTL);
    return result;
  }

  /** Batiza uma campanha. Chave é (tenant, source, campaign_id). */
  async setCampaignLabel(tenantId: string, body: unknown) {
    const d = campaignLabelSchema.parse(body);
    const saved = await this.prisma.adCampaignLabel.upsert({
      where: {
        tenant_id_source_campaign_id: {
          tenant_id: tenantId,
          source: d.source,
          campaign_id: d.campaign_id,
        },
      },
      create: { tenant_id: tenantId, ...d },
      update: { label: d.label },
    });
    return { source: saved.source, campaign_id: saved.campaign_id, label: saved.label };
  }
}
