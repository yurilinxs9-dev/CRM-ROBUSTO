import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class UsersService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.user.findMany({
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
        ativo: true,
        avatar_url: true,
        created_at: true,
      },
      orderBy: { nome: 'asc' },
    });
  }

  findAllForTenant(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId, ativo: true },
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
      },
      orderBy: { nome: 'asc' },
    });
  }
}
