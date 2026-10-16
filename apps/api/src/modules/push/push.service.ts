import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as webpush from 'web-push';
import { PrismaService } from '../../common/prisma/prisma.service';
import { isPlSalesOnly, PL_SALES_TENANT_ID } from '../../common/access/pl-sales-access';

export interface PushPayload {
  title: string;
  body: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
}

interface SubscriptionInput {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

@Injectable()
export class PushService implements OnModuleInit {
  private readonly logger = new Logger(PushService.name);
  private vapidConfigured = false;

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit() {
    const publicKey = this.config.get<string>('VAPID_PUBLIC_KEY');
    const privateKey = this.config.get<string>('VAPID_PRIVATE_KEY');
    const subject = this.config.get<string>('VAPID_SUBJECT', 'mailto:admin@example.com');
    if (publicKey && privateKey) {
      webpush.setVapidDetails(subject, publicKey, privateKey);
      this.vapidConfigured = true;
      this.logger.log('VAPID configured');
    } else {
      this.logger.warn('VAPID keys missing — push disabled');
    }
  }

  getPublicKey(): string | null {
    return this.config.get<string>('VAPID_PUBLIC_KEY') ?? null;
  }

  async subscribe(userId: string, tenantId: string, sub: SubscriptionInput) {
    return this.prisma.pushSubscription.upsert({
      where: { endpoint: sub.endpoint },
      create: {
        user_id: userId,
        tenant_id: tenantId,
        endpoint: sub.endpoint,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: sub.userAgent ?? null,
      },
      update: {
        user_id: userId,
        tenant_id: tenantId,
        p256dh: sub.keys.p256dh,
        auth: sub.keys.auth,
        user_agent: sub.userAgent ?? null,
      },
    });
  }

  async unsubscribe(endpoint: string) {
    await this.prisma.pushSubscription
      .delete({ where: { endpoint } })
      .catch(() => undefined);
  }

  async sendToUsers(userIds: string[], payload: PushPayload) {
    if (!this.vapidConfigured || userIds.length === 0) return;
    let subs = await this.prisma.pushSubscription.findMany({
      where: { user_id: { in: userIds } },
      include: { user: { select: { tenant_id: true, role: true, pl_sales_only: true } } },
    });
    const restricted = (s: (typeof subs)[number]) => isPlSalesOnly({ tenantId: s.user.tenant_id, role: s.user.role, plSalesOnly: s.user.pl_sales_only });
    if (subs.some(restricted)) {
      const match = /^\/chat\/([0-9a-f-]{36})$/i.exec(payload.url ?? '');
      const lead = match ? await this.prisma.lead.findFirst({
        where: { id: match[1], tenant_id: PL_SALES_TENANT_ID }, select: { responsavel_id: true },
      }) : null;
      subs = subs.filter(s => !restricted(s) || s.user_id === lead?.responsavel_id);
    }
    await Promise.all(
      subs.map((s) =>
        webpush
          .sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
          )
          .catch(async (err: unknown) => {
            const status = (err as { statusCode?: number }).statusCode;
            if (status === 404 || status === 410) {
              await this.prisma.pushSubscription
                .delete({ where: { id: s.id } })
                .catch(() => undefined);
            } else {
              this.logger.warn(`push send failed: ${(err as Error).message}`);
            }
          }),
      ),
    );
  }
}
