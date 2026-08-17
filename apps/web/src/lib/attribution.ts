/**
 * Tipos e rótulos da atribuição de origem. Espelho do backend
 * (apps/api/src/modules/attribution). Ver docs/specs/atribuicao-de-origem.md.
 */

export type AttributionChannel =
  | 'META_ADS'
  | 'GOOGLE_ADS'
  | 'GOOGLE_ORGANIC'
  | 'SOCIAL_ORGANIC'
  | 'REFERRAL'
  | 'DIRECT'
  | 'INDICACAO'
  | 'UNKNOWN';

export interface AttributionBucket {
  leads: number;
  won: number;
  lost: number;
  won_value: number;
  conversion_rate: number;
}

export interface ChannelRow extends AttributionBucket {
  channel: AttributionChannel | string;
  paid: boolean;
}

export interface AttributionSummary {
  period: { from: string; to: string };
  total: AttributionBucket;
  channels: ChannelRow[];
  paid: { leads: number; share: number; won: number; won_value: number };
}

export interface CampaignRow extends AttributionBucket {
  source: string;
  campaign_id: string;
  label: string;
  has_custom_label: boolean;
}

export interface KeywordRow extends AttributionBucket {
  keyword: string;
}

export interface AttributionCampaigns {
  period: { from: string; to: string };
  campaigns: CampaignRow[];
  keywords: KeywordRow[];
}

/**
 * Cor e rótulo por canal. Pago em tons quentes, orgânico em frios — a leitura
 * do donut fica correta mesmo sem ler a legenda.
 */
export const CHANNEL_META: Record<string, { label: string; color: string }> = {
  META_ADS: { label: 'Meta Ads', color: '#f97316' },
  GOOGLE_ADS: { label: 'Google Ads', color: '#ef4444' },
  GOOGLE_ORGANIC: { label: 'Busca orgânica', color: '#3b82f6' },
  SOCIAL_ORGANIC: { label: 'Social orgânico', color: '#8b5cf6' },
  REFERRAL: { label: 'Outros sites', color: '#14b8a6' },
  DIRECT: { label: 'Direto', color: '#64748b' },
  INDICACAO: { label: 'Indicação', color: '#22c55e' },
  UNKNOWN: { label: 'Não identificado', color: '#94a3b8' },
};

export function channelMeta(channel: string): { label: string; color: string } {
  return CHANNEL_META[channel] ?? { label: channel, color: '#94a3b8' };
}

export const percentFmt = (v: number): string => `${(v * 100).toFixed(1)}%`;
