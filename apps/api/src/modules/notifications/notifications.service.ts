import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { isPlSalesOnly } from '../../common/access/pl-sales-access';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: AuthUser) {
    const notifications = await this.prisma.notification.findMany({
      where: { user_id: user.id, tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
    if (!isPlSalesOnly(user)) return notifications;
    const ids = notifications.map(n => this.chatLead(n.link)).filter((id): id is string => !!id);
    const leads = ids.length ? await this.prisma.lead.findMany({
      where: { id: { in: ids }, tenant_id: user.tenantId, responsavel_id: user.id }, select: { id: true },
    }) : [];
    const allowed = new Set(leads.map(lead => lead.id));
    return notifications.filter(n => allowed.has(this.chatLead(n.link) ?? ''));
  }

  private chatLead(link: string | null): string | undefined {
    return /^\/chat\/([0-9a-f-]{36})$/i.exec(link ?? '')?.[1];
  }

  async markRead(id: string, user: AuthUser) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, user_id: user.id, tenant_id: user.tenantId },
    });
    if (!existing) throw new NotFoundException('Notificacao nao encontrada');
    if (isPlSalesOnly(user)) {
      const leadId = this.chatLead(existing.link);
      if (!leadId || !await this.prisma.lead.findFirst({
        where: { id: leadId, tenant_id: user.tenantId, responsavel_id: user.id }, select: { id: true },
      })) throw new NotFoundException('Notificacao nao encontrada');
    }
    return this.prisma.notification.update({ where: { id }, data: { lida: true } });
  }

  async markAllRead(user: AuthUser) {
    const res = await this.prisma.notification.updateMany({
      where: { user_id: user.id, tenant_id: user.tenantId, lida: false },
      data: { lida: true },
    });
    return { ok: true, ...(!isPlSalesOnly(user) ? { updated: res.count } : {}) };
  }

  /** Marca como lidas as notificações de uma conversa (ao abrir/responder). */
  async markByLead(leadId: string, user: AuthUser) {
    const res = await this.prisma.notification.updateMany({
      where: { user_id: user.id, tenant_id: user.tenantId, link: `/chat/${leadId}`, lida: false },
      data: { lida: true },
    });
    return { ok: true, updated: res.count };
  }
}
