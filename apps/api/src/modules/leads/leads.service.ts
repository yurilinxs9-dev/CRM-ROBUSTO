import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import {
  PIPELINE_AUTO_ACTIONS_QUEUE,
  type AutoActionJobData,
} from '../pipelines/auto-actions.processor';
import { InstancesService } from '../instances/instances.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { z } from 'zod';

const LEADS_LIST_TTL_SECONDS = 15;
const leadsListPattern = (tenantId: string) => `leads:list:${tenantId}:*`;

interface InstanceConfig {
  uazapi_token?: string;
  [key: string]: unknown;
}

const updateStageSchema = z.object({ estagio_id: z.string().uuid() });
const updateLeadSchema = z.object({
  nome: z.string().min(1).optional(),
  telefone: z.string().min(8).optional(),
  email: z.string().email().optional().nullable(),
  temperatura: z.enum(['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE']).optional(),
  valor_estimado: z.string().optional().nullable(),
  responsavel_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
});
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
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private prisma: PrismaService,
    private instances: InstancesService,
    private cache: RedisCacheService,
    private gateway: CrmGateway,
    @InjectQueue(PIPELINE_AUTO_ACTIONS_QUEUE)
    private autoActionsQueue: Queue<AutoActionJobData>,
  ) {}

  async invalidateLeadsCache(tenantId: string): Promise<void> {
    await this.cache.delPattern(leadsListPattern(tenantId));
  }

  private buildLeadsListKey(
    tenantId: string,
    filters: LeadFilters,
    role: string,
    userId: string,
  ): string {
    const hash = createHash('sha1')
      .update(JSON.stringify({ filters, role, userId }))
      .digest('hex')
      .slice(0, 16);
    return `leads:list:${tenantId}:${hash}`;
  }

  async syncProfile(leadId: string, user?: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: user ? { id: leadId, tenant_id: user.tenantId } : { id: leadId },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (!lead.instancia_whatsapp) return lead;

    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome: lead.instancia_whatsapp, tenant_id: lead.tenant_id },
    });
    const cfg = (instance?.config ?? {}) as InstanceConfig;
    const token = cfg.uazapi_token;
    if (!token) return lead;

    const profile = await this.instances.fetchProfile(token, lead.telefone);
    const data: { nome?: string; foto_url?: string } = {};
    if (profile.name && lead.nome === lead.telefone) data.nome = profile.name;
    if (profile.imageUrl) data.foto_url = profile.imageUrl;
    if (Object.keys(data).length === 0) return lead;
    return this.prisma.lead.update({ where: { id: leadId }, data });
  }

  async syncActiveLeadsProfiles(limit = 50): Promise<{ synced: number }> {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const leads = await this.prisma.lead.findMany({
      where: { ultima_interacao: { gte: thirtyDaysAgo } },
      orderBy: { ultima_interacao: 'desc' },
      take: limit,
      select: { id: true },
    });
    let synced = 0;
    for (const l of leads) {
      try {
        await this.syncProfile(l.id);
        synced++;
      } catch (err) {
        this.logger.warn(`sync batch erro lead ${l.id}: ${String(err)}`);
      }
    }
    return { synced };
  }

  async syncProfileSafe(leadId: string): Promise<void> {
    try {
      await this.syncProfile(leadId);
    } catch (err) {
      this.logger.warn(`syncProfileSafe(${leadId}) falhou: ${String(err)}`);
    }
  }

  async findAll(user: AuthUser, filters: LeadFilters = {}) {
    const where: Record<string, unknown> = { tenant_id: user.tenantId };

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

    const cacheKey = this.buildLeadsListKey(user.tenantId, filters, user.role, user.id);
    const cached = await this.cache.get<unknown[]>(cacheKey);
    if (cached) return cached;

    const leads = await this.prisma.lead.findMany({
      relationLoadStrategy: 'join',
      where,
      select: {
        id: true,
        nome: true,
        telefone: true,
        foto_url: true,
        temperatura: true,
        valor_estimado: true,
        mensagens_nao_lidas: true,
        ultima_interacao: true,
        updated_at: true,
        estagio_id: true,
        estagio_entered_at: true,
        pipeline_id: true,
        tags: true,
        position: true,
        responsavel: { select: { id: true, nome: true, avatar_url: true } },
        estagio: { select: { id: true, nome: true, cor: true } },
        lead_tags: { include: { tag: true } },
        messages: {
          orderBy: { created_at: 'desc' },
          take: 1,
          select: { content: true, type: true, direction: true, created_at: true },
        },
        _count: {
          select: { tasks: { where: { status: 'PENDENTE' } } },
        },
      },
      orderBy: [{ estagio_id: 'asc' }, { position: 'asc' }],
      take: filters.limit ? Math.min(parseInt(filters.limit), 200) : 50,
      skip: filters.offset ? parseInt(filters.offset) : 0,
    });

    const result = leads.map((lead) => {
      const last = lead.messages[0];
      let preview = '';
      if (last) {
        if (last.type === 'TEXT') preview = last.content ?? '';
        else if (last.type === 'IMAGE') preview = '📷 Imagem';
        else if (last.type === 'VIDEO') preview = '🎥 Vídeo';
        else if (last.type === 'AUDIO') preview = '🎵 Áudio';
        else if (last.type === 'DOCUMENT') preview = '📄 Documento';
        else if (last.type === 'STICKER') preview = 'Figurinha';
        else if (last.type === 'LOCATION') preview = '📍 Localização';
        else preview = last.content ?? '';
      }
      const { messages: _messages, _count, ...rest } = lead;
      void _messages;
      return {
        ...rest,
        ultimo_mensagem: preview,
        ultima_interacao: lead.ultima_interacao ?? last?.created_at ?? null,
        pending_tasks_count: _count?.tasks ?? 0,
      };
    });

    await this.cache.set(cacheKey, result, LEADS_LIST_TTL_SECONDS);
    return result;
  }

  async findOne(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
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

  async remove(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (user.role === UserRole.OPERADOR && lead.responsavel_id !== user.id) {
      throw new ForbiddenException();
    }
    await this.prisma.lead.delete({ where: { id } });
    await this.invalidateLeadsCache(user.tenantId);
    return { success: true };
  }

  async create(data: unknown, user: AuthUser) {
    const parsed = createLeadSchema.parse(data);
    const lead = await this.prisma.lead.create({
      data: {
        ...parsed,
        responsavel_id: parsed.responsavel_id || user.id,
        origem: 'MANUAL',
        tenant_id: user.tenantId,
      },
    });
    await this.invalidateLeadsCache(user.tenantId);
    return lead;
  }

  async update(id: string, data: unknown, user: AuthUser) {
    const parsed = updateLeadSchema.parse(data);

    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (user.role === UserRole.OPERADOR && lead.responsavel_id !== user.id) {
      throw new ForbiddenException();
    }

    const updateData: Record<string, unknown> = {};
    if (parsed.nome !== undefined) updateData.nome = parsed.nome;
    if (parsed.telefone !== undefined) updateData.telefone = parsed.telefone;
    if (parsed.email !== undefined) updateData.email = parsed.email ?? null;
    if (parsed.temperatura !== undefined) updateData.temperatura = parsed.temperatura;
    if (parsed.valor_estimado !== undefined) updateData.valor_estimado = parsed.valor_estimado ?? null;
    if (parsed.responsavel_id !== undefined) updateData.responsavel_id = parsed.responsavel_id;
    if (parsed.tags !== undefined) updateData.tags = parsed.tags;

    const updated = await this.prisma.lead.update({
      where: { id },
      data: updateData,
      include: {
        responsavel: { select: { id: true, nome: true, avatar_url: true } },
        estagio: true,
        pipeline: true,
        lead_tags: { include: { tag: true } },
      },
    });

    await this.invalidateLeadsCache(user.tenantId);

    try {
      this.gateway.emitLeadUpdated(id, { leadId: id, triggeredByUserId: user.id }, user.tenantId);
    } catch (err) {
      this.logger.warn(`emitLeadUpdated failed for lead ${id}: ${String(err)}`);
    }

    return updated;
  }

  async updateStage(id: string, data: unknown, user: AuthUser) {
    const { estagio_id } = updateStageSchema.parse(data);

    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!lead) throw new NotFoundException();

    const [updatedLead] = await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id },
        data: { estagio_id, estagio_entered_at: new Date() },
      }),
      this.prisma.leadActivity.create({
        data: {
          lead_id: id,
          user_id: user.id,
          tipo: 'stage_change',
          descricao: 'Movido para novo estagio',
          dados_antes: { estagio_id: lead.estagio_id },
          dados_depois: { estagio_id },
          tenant_id: user.tenantId,
        },
      }),
    ]);

    await this.invalidateLeadsCache(user.tenantId);

    try {
      this.gateway.emitLeadStageChanged(
        id,
        { newStageId: estagio_id, oldStageId: lead.estagio_id, leadId: id, triggeredByUserId: user.id },
        user.tenantId,
      );
    } catch (err) {
      this.logger.warn(`emitLeadStageChanged failed for lead ${id}: ${String(err)}`);
    }

    // Fire-and-forget enqueue of stage auto-actions; failure must not break the move.
    if (estagio_id !== lead.estagio_id) {
      try {
        await this.autoActionsQueue.add(
          'on-stage-enter',
          {
            leadId: id,
            newStageId: estagio_id,
            tenantId: user.tenantId,
            triggeredByUserId: user.id,
          },
          { removeOnComplete: true, removeOnFail: 50 },
        );
      } catch (err) {
        this.logger.warn(`auto-actions enqueue failed for lead ${id}: ${String(err)}`);
      }
    }

    return updatedLead;
  }

  async getMessages(leadId: string, user: AuthUser, cursor?: string, limit = 50) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    const rows = await this.prisma.message.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const messages = hasMore ? rows.slice(0, limit) : rows;
    return {
      messages,
      nextCursor: hasMore ? messages[messages.length - 1].id : undefined,
    };
  }

  async markAsRead(leadId: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    await this.prisma.lead.update({
      where: { id: leadId },
      data: { mensagens_nao_lidas: 0 },
    });
    await this.prisma.message.updateMany({
      where: { lead_id: leadId, direction: 'INCOMING', status: { not: 'READ' } },
      data: { status: 'READ' },
    });
    await this.invalidateLeadsCache(user.tenantId);
  }
}
