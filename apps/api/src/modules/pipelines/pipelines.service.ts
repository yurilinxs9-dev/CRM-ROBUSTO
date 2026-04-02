import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class PipelinesService {
  constructor(private prisma: PrismaService) {}

  async findAll() {
    return this.prisma.pipeline.findMany({
      where: { ativo: true },
      include: {
        stages: { orderBy: { ordem: 'asc' } },
        _count: { select: { leads: true } },
      },
      orderBy: { ordem: 'asc' },
    });
  }

  async findOne(id: string) {
    return this.prisma.pipeline.findUnique({
      where: { id },
      include: {
        stages: {
          orderBy: { ordem: 'asc' },
          include: { _count: { select: { leads: true } } },
        },
      },
    });
  }
}
