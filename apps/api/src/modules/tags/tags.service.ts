import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  findAll(user: AuthUser, limit = 200, offset = 0) {
    return this.prisma.tag.findMany({
      where: { tenant_id: user.tenantId },
      orderBy: { nome: 'asc' },
      take: limit,
      skip: offset,
    });
  }

  create(user: AuthUser, nome: string, cor: string) {
    return this.prisma.tag.create({
      data: { nome, cor, tenant_id: user.tenantId },
    });
  }
}
