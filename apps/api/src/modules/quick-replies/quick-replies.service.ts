import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

interface CreateQuickReplyDto {
  titulo: string;
  conteudo: string;
  is_global?: boolean;
}

@Injectable()
export class QuickRepliesService {
  constructor(private prisma: PrismaService) {}

  findAll(userId: string) {
    return this.prisma.quickReply.findMany({
      where: { OR: [{ is_global: true }, { user_id: userId }] },
      orderBy: { titulo: 'asc' },
    });
  }

  create(data: CreateQuickReplyDto, userId: string) {
    return this.prisma.quickReply.create({
      data: {
        titulo: data.titulo,
        conteudo: data.conteudo,
        is_global: data.is_global ?? false,
        user_id: userId,
      },
    });
  }
}
