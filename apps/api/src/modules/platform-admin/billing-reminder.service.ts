import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { deriveBillingStatus } from './billing-status';

const fmt = (x: Date) =>
  `${String(x.getUTCDate()).padStart(2, '0')}/${String(x.getUTCMonth() + 1).padStart(2, '0')}/${x.getUTCFullYear()}`;

/**
 * Aviso automático de vencimento: vira announcement direcionado ao tenant
 * (banner que o dono já vê no painel). Dedupe pelo título determinístico com a
 * data de vencimento — mudou o paid_until, muda o título, novo aviso.
 */
@Injectable()
export class BillingReminderService {
  private readonly logger = new Logger(BillingReminderService.name);
  constructor(private readonly prisma: PrismaService) {}

  @Cron('0 12 * * *') // 12:00 UTC = 9h BRT
  async cron(): Promise<void> {
    const r = await this.run().catch((err) => {
      this.logger.warn(`billing reminder falhou: ${String(err)}`);
      return { created: 0 };
    });
    if (r.created) this.logger.log(`billing reminder: ${r.created} aviso(s) criado(s)`);
  }

  async run(now: Date = new Date()): Promise<{ created: number }> {
    const tenants = await this.prisma.tenant.findMany({
      where: { billing_paid_until: { not: null }, suspended_at: null },
      select: { id: true, billing_value: true, billing_cycle_months: true, billing_paid_until: true, suspended_at: true },
    });
    // created_by é NOT NULL no Announcement: usa o primeiro admin master ativo.
    const master = await this.prisma.user.findFirst({
      where: { ativo: true, is_platform_admin: true, platform_scopes: { has: '*' } },
      select: { id: true },
    });
    if (!master) return { created: 0 };
    let created = 0;
    for (const t of tenants) {
      if (t.suspended_at) continue;
      const { status, dias } = deriveBillingStatus(t, now);
      if (status !== 'vence_em_breve' && status !== 'vencido') continue;
      const due = t.billing_paid_until as Date;
      const title = status === 'vencido' ? `Fatura vencida (${fmt(due)})` : `Fatura vence em breve (${fmt(due)})`;
      const dup = await this.prisma.announcement.findFirst({ where: { title, target_tenant_id: t.id, active: true } });
      if (dup) continue;
      await this.prisma.announcement.create({
        data: {
          title,
          body:
            status === 'vencido'
              ? `Sua assinatura venceu há ${dias} dia(s). Regularize o pagamento para evitar suspensão do acesso.`
              : `Sua assinatura vence em ${dias} dia(s) (${fmt(due)}). Evite interrupção do serviço.`,
          level: 'WARNING',
          target_tenant_id: t.id,
          created_by: master.id,
        },
      });
      created++;
    }
    return { created };
  }
}
