import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class NotificationsService {
  constructor(private prisma: PrismaService) {}

  findAll(user: AuthUser) {
    return this.prisma.notification.findMany({
      where: { user_id: user.id, tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      take: 50,
    });
  }

  async markRead(id: string, user: AuthUser) {
    const existing = await this.prisma.notification.findFirst({
      where: { id, user_id: user.id, tenant_id: user.tenantId },
    });
    if (!existing) throw new NotFoundException('Notificacao nao encontrada');
    return this.prisma.notification.update({ where: { id }, data: { lida: true } });
  }
}
