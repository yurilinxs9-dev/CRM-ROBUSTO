export const OUTBOUND_WEBHOOKS_QUEUE = 'outbound-webhooks';

export type OutboundWebhookEvent =
  | 'message.created'
  | 'lead.created'
  | 'lead.updated'
  | 'deal.won'
  | 'deal.lost';

export const ALL_EVENTS: OutboundWebhookEvent[] = [
  'message.created',
  'lead.created',
  'lead.updated',
  'deal.won',
  'deal.lost',
];

export interface DispatchJobData {
  webhookId: string;
  eventType: OutboundWebhookEvent;
  payload: Record<string, unknown>;
}
