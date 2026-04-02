import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

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
}
