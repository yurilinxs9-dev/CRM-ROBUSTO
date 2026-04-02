import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

@Injectable()
export class TagsService {
  constructor(private prisma: PrismaService) {}

  findAll() {
    return this.prisma.tag.findMany({ orderBy: { nome: 'asc' } });
  }

  create(nome: string, cor: string) {
    return this.prisma.tag.create({ data: { nome, cor } });
  }
}
