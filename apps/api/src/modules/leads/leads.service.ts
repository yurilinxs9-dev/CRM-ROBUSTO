import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { UserRole } from '@/common/types/roles';
import { z } from 'zod';

const updateStageSchema = z.object({ estagio_id: z.string().uuid() });
const createLeadSchema = z.object({
  nome: z.string().min(1),
  telefone: z.string().min(10),
  email: z.string().email().optional(),
  empresa: z.string().optional(),
  pipeline_id: z.string().uuid(),
  estagio_id: z.string().uuid(),
  instancia_whatsapp: z.string(),
  responsavel_id: z.string().uuid().optional(),
});

interface AuthUser {
  id: string;
  nome: string;
  email: string;
  role: UserRole;
  ativo: boolean;
}

interface LeadFilters {
  pipeline_id?: string;
  estagio_id?: string;
  responsavel_id?: string;
  instancia?: string;
  temperatura?: string;
  search?: string;
  limit?: string;
  offset?: string;
}

@Injectable()
export class LeadsService {
  constructor(private prisma: PrismaService) {}

  async findAll(user: AuthUser, filters: LeadFilters = {}) {
    const where: Record<string, unknown> = {};

    if (user.role === UserRole.OPERADOR) {
      where.responsavel_id = user.id;
    }

    if (filters.pipeline_id) where.pipeline_id = filters.pipeline_id;
    if (filters.estagio_id) where.estagio_id = filters.estagio_id;
    if (filters.responsavel_id) where.responsavel_id = filters.responsavel_id;
    if (filters.instancia) where.instancia_whatsapp = filters.instancia;
    if (filters.temperatura) where.temperatura = filters.temperatura;
    if (filters.search) {
      where.OR = [
        { nome: { contains: filters.search, mode: 'insensitive' } },
        { telefone: { contains: filters.search } },
      ];
    }

    return this.prisma.lead.findMany({
      where,
      include: {
        responsavel: { select: { id: true, nome: true, avatar_url: true } },
        estagio: { select: { id: true, nome: true, cor: true } },
        lead_tags: { include: { tag: true } },
      },
      orderBy: [{ estagio_id: 'asc' }, { position: 'asc' }],
      take: filters.limit ? parseInt(filters.limit) : 200,
      skip: filters.offset ? parseInt(filters.offset) : 0,
    });
  }

  async findOne(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findUnique({
      where: { id },
      include: {
        responsavel: { select: { id: true, nome: true, avatar_url: true } },
        estagio: true,
        pipeline: true,
        lead_tags: { include: { tag: true } },
        activities: {
          orderBy: { created_at: 'desc' },
          take: 20,
          include: { user: { select: { id: true, nome: true } } },
        },
      },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (user.role === UserRole.OPERADOR && lead.responsavel_id !== user.id) {
      throw new ForbiddenException();
    }
    return lead;
  }

  async create(data: unknown, user: AuthUser) {
    const parsed = createLeadSchema.parse(data);
    return this.prisma.lead.create({
      data: {
        ...parsed,
        responsavel_id: parsed.responsavel_id || user.id,
        origem: 'MANUAL',
      },
    });
  }

  async updateStage(id: string, data: unknown, user: AuthUser) {
    const { estagio_id } = updateStageSchema.parse(data);

    const lead = await this.prisma.lead.findUnique({ where: { id } });
    if (!lead) throw new NotFoundException();

    const [updatedLead] = await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id },
        data: { estagio_id },
      }),
      this.prisma.leadActivity.create({
        data: {
          lead_id: id,
          user_id: user.id,
          tipo: 'stage_change',
          descricao: 'Movido para novo estagio',
          dados_antes: { estagio_id: lead.estagio_id },
          dados_depois: { estagio_id },
        },
      }),
    ]);

    return updatedLead;
  }

  async getMessages(leadId: string, cursor?: string, limit = 50) {
    return this.prisma.message.findMany({
      where: { lead_id: leadId },
      orderBy: { created_at: 'desc' },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
  }

  async markAsRead(leadId: string) {
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { mensagens_nao_lidas: 0 },
    });
    await this.prisma.message.updateMany({
      where: { lead_id: leadId, direction: 'INCOMING', status: { not: 'READ' } },
      data: { status: 'READ' },
    });
  }
}
