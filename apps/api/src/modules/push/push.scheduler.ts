import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { PushService } from './push.service';

@Injectable()
export class PushScheduler {
  private readonly logger = new Logger(PushScheduler.name);
  private lastNotifiedFollowUp = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly push: PushService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async checkSlaWindow() {
    const now = new Date();
    const tenants = await this.prisma.tenant.findMany({
      select: { id: true, notification_lead_minutes: true },
    });
    for (const t of tenants) {
      const windowEnd = new Date(now.getTime() + t.notification_lead_minutes * 60 * 1000);
      const due = await this.prisma.lead.findMany({
        where: {
          tenant_id: t.id,
          responsavel_id: { not: null },
          proximo_followup: { gte: now, lte: windowEnd },
        },
        select: { id: true, nome: true, telefone: true, responsavel_id: true, proximo_followup: true },
      });
      for (const lead of due) {
        if (!lead.responsavel_id || !lead.proximo_followup) continue;
        const key = `${lead.id}:${lead.proximo_followup.getTime()}`;
        if (this.lastNotifiedFollowUp.has(key)) continue;
        this.lastNotifiedFollowUp.set(key, Date.now());
        await this.push.sendToUsers([lead.responsavel_id], {
          title: 'Follow-up vencendo',
          body: `${lead.nome} — ${t.notification_lead_minutes} min`,
          url: `/leads/${lead.id}`,
          tag: `sla-${lead.id}`,
          data: { leadId: lead.id, type: 'sla' },
        });
      }
    }
    if (this.lastNotifiedFollowUp.size > 5000) {
      const cutoff = Date.now() - 24 * 60 * 60 * 1000;
      for (const [k, v] of this.lastNotifiedFollowUp) {
        if (v < cutoff) this.lastNotifiedFollowUp.delete(k);
      }
    }
  }
}
