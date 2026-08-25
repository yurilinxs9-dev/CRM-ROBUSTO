export const LEAD_INSIGHTS_QUEUE = 'lead-insights';

/** Payload do job de geracao da ficha inteligente do lead. */
export interface GerarInsightJobData {
  leadId: string;
  tenantId: string;
}
