/**
 * Classificador de origem. Módulo puro: sem Prisma, sem Nest, sem IO — só
 * entrada → canal. É onde mora toda a regra de "isto é tráfego pago ou não",
 * justamente para caber em teste unitário sem banco.
 *
 * Ver docs/specs/atribuicao-de-origem.md.
 */
import { AttributionChannel } from '@prisma/client';
import type { AttributionInput } from './attribution.types';

export interface NormalizedAttribution {
  channel: AttributionChannel;
  paid: boolean;
  source: string | null;
  campaign_id: string | null;
  campaign_name: string | null;
  adgroup_id: string | null;
  creative_id: string | null;
  keyword: string | null;
  match_type: string | null;
  network: string | null;
  device: string | null;
  gclid: string | null;
  wbraid: string | null;
  gbraid: string | null;
  fbclid: string | null;
  ctwa_clid: string | null;
  utm_source: string | null;
  utm_medium: string | null;
  utm_campaign: string | null;
  utm_term: string | null;
  utm_content: string | null;
  ad_id: string | null;
  ad_title: string | null;
  ad_url: string | null;
  landing_url: string | null;
  referrer: string | null;
  clicked_at: Date | null;
}

/**
 * `utm_medium` que significa mídia paga. A lista é generosa de propósito:
 * cada agência escreve de um jeito, e classificar tráfego pago como orgânico
 * é o erro que estraga a decisão que o relatório existe para embasar.
 */
const PAID_MEDIUMS = new Set([
  'cpc',
  'ppc',
  'cpm',
  'cpv',
  'cpa',
  'paid',
  'paidsearch',
  'paid_search',
  'paid-search',
  'paidsocial',
  'paid_social',
  'paid-social',
  'display',
  'banner',
  'ads',
  'ad',
  'adwords',
  'retargeting',
  'remarketing',
]);

const GOOGLE_SOURCES = new Set([
  'google',
  'adwords',
  'googleads',
  'google_ads',
  'google-ads',
  'google ads',
  'gdn',
  'youtube',
]);

const META_SOURCES = new Set([
  'facebook',
  'facebook_ads',
  'fb',
  'instagram',
  'instagram_ads',
  'ig',
  'meta',
  'meta_ads',
]);

/** Hosts de busca. `google.` cobre google.com, google.com.br, google.pt… */
const SEARCH_HOST_FRAGMENTS = ['google.', 'bing.', 'duckduckgo.', 'search.yahoo.', 'ecosia.'];

const SOCIAL_HOST_FRAGMENTS = [
  'instagram.',
  'facebook.',
  'l.facebook.',
  'lm.facebook.',
  'messenger.',
  'linkedin.',
  'lnkd.in',
  't.co',
  'twitter.',
  'x.com',
  'tiktok.',
  'youtube.',
  'youtu.be',
  'pinterest.',
];

const lower = (v: string | undefined): string | undefined => v?.toLowerCase();

const nn = (v: string | undefined): string | null => (v === undefined ? null : v);

function hostOf(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    return new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
}

function matchesAny(host: string, fragments: string[]): boolean {
  return fragments.some((f) => host === f || host.includes(f));
}

/** `instagram`/`facebook` viram a plataforma; qualquer outra coisa vira `meta`. */
function metaSource(sourceApp: string | undefined): string {
  const s = lower(sourceApp);
  if (s === 'instagram' || s === 'facebook') return s;
  return 'meta';
}

/**
 * O ValueTrack entrega `{campaignid}` numérico. Quando a UTM traz texto, é
 * porque alguém escreveu o nome à mão — aí ele já serve de rótulo e dispensa
 * o AdCampaignLabel.
 */
function splitCampaign(value: string | undefined): {
  campaign_id: string | null;
  campaign_name: string | null;
} {
  if (!value) return { campaign_id: null, campaign_name: null };
  const numerico = /^\d+$/.test(value);
  return { campaign_id: value, campaign_name: numerico ? null : value };
}

/** Campos copiados como estão, independente do canal em que o lead cair. */
function carryOver(input: AttributionInput): Omit<NormalizedAttribution, 'channel' | 'paid' | 'source' | 'campaign_id' | 'campaign_name'> {
  return {
    adgroup_id: nn(input.adgroupid),
    creative_id: nn(input.creative ?? input.utm_content),
    keyword: nn(input.keyword ?? input.utm_term),
    match_type: nn(input.matchtype),
    network: nn(input.network),
    device: nn(input.device),
    gclid: nn(input.gclid),
    wbraid: nn(input.wbraid),
    gbraid: nn(input.gbraid),
    fbclid: nn(input.fbclid),
    ctwa_clid: nn(input.ctwa_clid),
    utm_source: nn(input.utm_source),
    utm_medium: nn(input.utm_medium),
    utm_campaign: nn(input.utm_campaign),
    utm_term: nn(input.utm_term),
    utm_content: nn(input.utm_content),
    ad_id: nn(input.ad_id),
    ad_title: nn(input.ad_title),
    ad_url: nn(input.ad_url),
    landing_url: nn(input.landing_url),
    referrer: nn(input.referrer),
    clicked_at: input.clicked_at ?? null,
  };
}

/**
 * Devolve o canal do lead. A ordem das regras é a própria decisão de produto:
 * evidência forte (click ID, anúncio) ganha de evidência declarada (UTM), que
 * ganha de evidência inferida (referrer).
 */
export function classifyAttribution(input: AttributionInput): NormalizedAttribution {
  const resto = carryOver(input);
  const utmSource = lower(input.utm_source);
  const utmMedium = lower(input.utm_medium);
  const pago = utmMedium !== undefined && PAID_MEDIUMS.has(utmMedium);
  const campanhaExplicita = input.campaignid ?? input.utm_campaign;

  // 1. Anúncio da Meta chegando pelo WhatsApp. É a evidência mais forte que
  //    existe: veio dentro do payload da própria mensagem, ninguém configurou
  //    nada. Agrupa por anúncio, e o título já serve de rótulo legível.
  if (input.ad_id || input.ctwa_clid) {
    return {
      ...resto,
      channel: AttributionChannel.META_ADS,
      paid: true,
      source: metaSource(input.source_app),
      campaign_id: nn(input.ad_id),
      campaign_name: nn(input.ad_title),
    };
  }

  // 2. Google Ads. O gclid resolve sozinho; wbraid/gbraid provam que é pago
  //    mas não dizem qual campanha (tráfego iOS/EEA restrito).
  const temClickGoogle = Boolean(input.gclid || input.wbraid || input.gbraid);
  if (temClickGoogle || (pago && utmSource !== undefined && GOOGLE_SOURCES.has(utmSource))) {
    return {
      ...resto,
      channel: AttributionChannel.GOOGLE_ADS,
      paid: true,
      source: 'google',
      ...splitCampaign(campanhaExplicita),
    };
  }

  // 3. Anúncio da Meta que manda para o site em vez do WhatsApp.
  if (input.fbclid || (pago && utmSource !== undefined && META_SOURCES.has(utmSource))) {
    return {
      ...resto,
      channel: AttributionChannel.META_ADS,
      paid: true,
      source: utmSource !== undefined && META_SOURCES.has(utmSource) ? utmSource : 'meta',
      ...splitCampaign(campanhaExplicita),
    };
  }

  // 4. Mídia paga numa plataforma que não sabemos nomear. Fica explícito como
  //    não identificado em vez de ser empurrado para dentro de outro canal.
  if (pago) {
    return {
      ...resto,
      channel: AttributionChannel.UNKNOWN,
      paid: true,
      source: nn(input.utm_source),
      ...splitCampaign(campanhaExplicita),
    };
  }

  // 5. UTM sem mídia paga — link de bio, newsletter, parceiro.
  if (utmSource !== undefined) {
    const canal = GOOGLE_SOURCES.has(utmSource)
      ? AttributionChannel.GOOGLE_ORGANIC
      : META_SOURCES.has(utmSource)
        ? AttributionChannel.SOCIAL_ORGANIC
        : AttributionChannel.REFERRAL;
    return {
      ...resto,
      channel: canal,
      paid: false,
      source: nn(input.utm_source),
      ...splitCampaign(campanhaExplicita),
    };
  }

  // 6. Sem marcação nenhuma: sobra o referrer.
  const host = hostOf(input.referrer);
  if (host) {
    const landingHost = hostOf(input.landing_url);
    if (matchesAny(host, SEARCH_HOST_FRAGMENTS)) {
      return {
        ...resto,
        channel: AttributionChannel.GOOGLE_ORGANIC,
        paid: false,
        source: host,
        campaign_id: null,
        campaign_name: null,
      };
    }
    if (matchesAny(host, SOCIAL_HOST_FRAGMENTS)) {
      return {
        ...resto,
        channel: AttributionChannel.SOCIAL_ORGANIC,
        paid: false,
        source: host,
        campaign_id: null,
        campaign_name: null,
      };
    }
    // Navegação dentro do próprio site não é origem — cai como direto.
    if (landingHost && host === landingHost) {
      return {
        ...resto,
        channel: AttributionChannel.DIRECT,
        paid: false,
        source: null,
        campaign_id: null,
        campaign_name: null,
      };
    }
    return {
      ...resto,
      channel: AttributionChannel.REFERRAL,
      paid: false,
      source: host,
      campaign_id: null,
      campaign_name: null,
    };
  }

  // 7. Visita ao site sem referrer é direto de verdade (digitou, favoritou).
  //    Já uma mensagem no WhatsApp sem nenhum contexto web é desconhecida —
  //    e essa diferença importa: uma é resposta, a outra é falta de dado.
  return {
    ...resto,
    channel: input.landing_url ? AttributionChannel.DIRECT : AttributionChannel.UNKNOWN,
    paid: false,
    source: null,
    campaign_id: null,
    campaign_name: null,
  };
}

/** Rótulo em português para o canal, usado no relatório e no card do lead. */
export const CHANNEL_LABELS: Record<AttributionChannel, string> = {
  META_ADS: 'Meta Ads',
  GOOGLE_ADS: 'Google Ads',
  GOOGLE_ORGANIC: 'Busca orgânica',
  SOCIAL_ORGANIC: 'Social orgânico',
  REFERRAL: 'Indicação de site',
  DIRECT: 'Direto',
  INDICACAO: 'Indicação',
  UNKNOWN: 'Não identificado',
};
