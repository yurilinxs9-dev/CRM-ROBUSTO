import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OutboundWebhooksService } from './outbound-webhooks.service';

@Injectable()
export class OutboundWebhooksCron {
  private readonly logger = new Logger(OutboundWebhooksCron.name);

  constructor(private readonly svc: OutboundWebhooksService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM, { timeZone: 'America/Sao_Paulo' })
  async cleanup() {
    try {
      await this.svc.cleanupOldDeliveries();
    } catch (e) {
      this.logger.error(`Cleanup falhou: ${(e as Error).message}`);
    }
  }
}
