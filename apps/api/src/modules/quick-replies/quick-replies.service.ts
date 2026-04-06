import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

interface CreateQuickReplyDto {
  titulo: string;
  conteudo: string;
  is_global?: boolean;
}

@Injectable()
export class QuickRepliesService {
  constructor(private prisma: PrismaService) {}

  findAll(user: AuthUser) {
    return this.prisma.quickReply.findMany({
      where: {
        tenant_id: user.tenantId,
        OR: [{ is_global: true }, { user_id: user.id }],
      },
      orderBy: { titulo: 'asc' },
    });
  }

  create(data: CreateQuickReplyDto, user: AuthUser) {
    return this.prisma.quickReply.create({
      data: {
        titulo: data.titulo,
        conteudo: data.conteudo,
        is_global: data.is_global ?? false,
        user_id: user.id,
        tenant_id: user.tenantId,
      },
    });
  }
}
