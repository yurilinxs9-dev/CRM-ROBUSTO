import { Injectable, Logger, NotFoundException, ForbiddenException, ConflictException, BadRequestException } from '@nestjs/common';
import type { Response } from 'express';
import { toCsv } from '../../common/csv/csv.util';
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
import { MediaService } from '../media/media.service';
import { PushService } from '../push/push.service';
import { OutboundWebhooksService } from '../outbound-webhooks/outbound-webhooks.service';
import { AssignmentService } from '../queue/assignment.service';
import { UserRole } from '@/common/types/roles';
import { buildVisibilityWhere, mergeSearchCondition } from './lead-visibility';
import { CustomFieldsService } from './custom-fields.service';
import type { AuthUser } from '../../common/types/auth-user';
import { z } from 'zod';

// Board é atualizado ao vivo via WebSocket (setQueryData no front); o cache só
// serve o reload frio. TTL maior corta re-query da lista pesada sem perder
// frescor. Mutações (claim/stage/archive/…) e inbound seguem invalidando na hora.
const LEADS_LIST_TTL_SECONDS = 10;
const leadsListPattern = (tenantId: string) => `leads:list:${tenantId}:*`;

interface InstanceConfig {
  uazapi_token?: string;
  provider?: 'uazapi' | 'evolution';
  evolution_token?: string;
  evolution_base_url?: string;
  [key: string]: unknown;
}

const updateStageSchema = z.object({
  estagio_id: z.string().uuid(),
  position: z.number().optional(),
});

const bulkIdsSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
});
const bulkMoveStageSchema = bulkIdsSchema.extend({
  estagio_id: z.string().uuid(),
});
const bulkAssignSchema = bulkIdsSchema.extend({
  responsavel_id: z.string().uuid(),
});
const bulkTagSchema = bulkIdsSchema.extend({
  tag: z.string().min(1).max(50),
});
const updateLeadSchema = z.object({
  nome: z.string().min(1).optional(),
  telefone: z.string().min(8).optional(),
  email: z.string().email().optional().nullable(),
  temperatura: z.enum(['FRIO', 'MORNO', 'QUENTE', 'MUITO_QUENTE']).optional(),
  valor_estimado: z.string().optional().nullable(),
  responsavel_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  // Campos customizados por tenant — validados contra CustomFieldDef ativas.
  dados_custom: z.record(z.unknown()).optional(),
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
const reassignSchema = z.object({
  novoResponsavelId: z.string().uuid(),
});
const moveToSectorSchema = z.object({
  sectorId: z.string().uuid(),
});

const roleHierarchy: Record<string, number> = {
  SUPER_ADMIN: 4,
  GERENTE: 3,
  OPERADOR: 2,
  VISUALIZADOR: 1,
};

interface LeadFilters {
  pipeline_id?: string;
  estagio_id?: string;
  responsavel_id?: string;
  instancia?: string;
  temperatura?: string;
  search?: string;
  limit?: string;
  offset?: string;
  scope?: string;
  unread?: string;
  per_stage?: string;
}

export interface ExportLeadFilters {
  pipeline_id?: string;
  estagio_id?: string;
  responsavel_id?: string;
  temperatura?: string;
  from?: string;
  to?: string;
}

@Injectable()
export class LeadsService {
  private readonly logger = new Logger(LeadsService.name);

  constructor(
    private prisma: PrismaService,
    private instances: InstancesService,
    private cache: RedisCacheService,
    private gateway: CrmGateway,
    private media: MediaService,
    private push: PushService,
    private outboundWebhooks: OutboundWebhooksService,
    private assignment: AssignmentService,
    private customFields: CustomFieldsService,
    @InjectQueue(PIPELINE_AUTO_ACTIONS_QUEUE)
    private autoActionsQueue: Queue<AutoActionJobData>,
  ) {}

  private async resolveMediaUrl(path: string | null): Promise<string | null> {
    if (!path) return null;
    if (/^https?:\/\//i.test(path)) return path;
    try {
      return await this.media.getSignedUrl(path, 3600);
    } catch (err) {
      this.logger.warn(`Falha ao gerar signed URL para ${path}: ${String(err)}`);
      return null;
    }
  }

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

  async syncProfile(leadId: string, user?: AuthUser, opts?: { force?: boolean }) {
    const lead = await this.prisma.lead.findFirst({
      where: user ? { id: leadId, tenant_id: user.tenantId } : { id: leadId },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (!lead.instancia_whatsapp) return lead;

    const instance = await this.prisma.whatsappInstance.findFirst({
      where: { nome: lead.instancia_whatsapp, tenant_id: lead.tenant_id },
    });
    const cfg = (instance?.config ?? {}) as InstanceConfig;

    let profile: { name?: string; imageUrl?: string };
    if (cfg.provider === 'evolution') {
      const apikey = cfg.evolution_token;
      const baseUrl = cfg.evolution_base_url || process.env['EVOLUTION_BASE_URL'] || '';
      if (!apikey || !baseUrl || !instance) return lead;
      profile = await this.instances.fetchProfileEvolution(
        baseUrl,
        apikey,
        instance.nome,
        lead.telefone,
      );
    } else {
      const token = cfg.uazapi_token;
      if (!token) return lead;
      profile = await this.instances.fetchProfile(token, lead.telefone);
    }
    const data: { nome?: string; foto_url?: string } = {};
    // With force=true (data-repair sweep) we always trust UazAPI's name.
    // Otherwise only fill the placeholder name (digits-only) to avoid
    // clobbering a name the user manually edited.
    if (profile.name && (opts?.force || lead.nome === lead.telefone)) {
      data.nome = profile.name;
    }
    if (profile.imageUrl) {
      try {
        data.foto_url = await this.media.mirrorFromUrl(
          `avatars/${leadId}`,
          profile.imageUrl,
        );
      } catch (err) {
        this.logger.warn(`Falha ao espelhar avatar do lead ${leadId}: ${String(err)}`);
      }
    }
    if (Object.keys(data).length === 0) return lead;
    return this.prisma.lead.update({ where: { id: leadId }, data });
  }

  /**
   * Repair sweep: force-resync name + photo from UazAPI for all active leads
   * in the tenant. Used to recover from the historical pushName corruption
   * bug. Runs in batches with bounded concurrency to avoid hammering UazAPI.
   */
  async syncAllProfilesForTenant(
    user: AuthUser,
  ): Promise<{ total: number; synced: number; failed: number }> {
    const ninetyDaysAgo = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const leads = await this.prisma.lead.findMany({
      where: {
        tenant_id: user.tenantId,
        ultima_interacao: { gte: ninetyDaysAgo },
      },
      orderBy: { ultima_interacao: 'desc' },
      select: { id: true },
    });

    let synced = 0;
    let failed = 0;
    const concurrency = 4;
    for (let i = 0; i < leads.length; i += concurrency) {
      const slice = leads.slice(i, i + concurrency);
      await Promise.all(
        slice.map(async (l) => {
          try {
            await this.syncProfile(l.id, user, { force: true });
            synced++;
          } catch (err) {
            failed++;
            this.logger.warn(`syncAll erro lead ${l.id}: ${String(err)}`);
          }
        }),
      );
    }

    await this.invalidateLeadsCache(user.tenantId);
    return { total: leads.length, synced, failed };
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

  /**
   * Nomes das instâncias WhatsApp acessíveis a esse user no tenant.
   * - Modo Individual (pool_enabled=false): só as próprias.
   * - Modo Compartilhado (pool_enabled=true): todas do tenant — número é
   *   da equipe, não pessoal.
   * Privacidade por lead nesse modo é regida por is_private/responsavel_id.
   */
  private async getOwnedInstanceNames(userId: string, tenantId: string): Promise<string[]> {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId },
      select: { pool_enabled: true },
    });
    const where = tenant?.pool_enabled
      ? { tenant_id: tenantId }
      : { owner_user_id: userId, tenant_id: tenantId };
    const rows = await this.prisma.whatsappInstance.findMany({
      where,
      select: { nome: true },
    });
    return rows.map((r) => r.nome);
  }

  async findAll(user: AuthUser, filters: LeadFilters = {}) {
    const where: Record<string, unknown> = { tenant_id: user.tenantId };

    // Visibilidade depende do MODO do tenant:
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: user.tenantId },
      select: { pool_enabled: true },
    });
    const poolEnabled = Boolean(tenant?.pool_enabled);
    Object.assign(
      where,
      buildVisibilityWhere({
        userId: user.id,
        role: user.role as UserRole,
        poolEnabled,
        scope: filters.scope,
      }),
    );

    if (filters.pipeline_id) where.pipeline_id = filters.pipeline_id;
    if (filters.estagio_id) where.estagio_id = filters.estagio_id;
    if (filters.responsavel_id) where.responsavel_id = filters.responsavel_id;
    if (filters.instancia) where.instancia_whatsapp = filters.instancia;
    if (filters.temperatura) where.temperatura = filters.temperatura;
    // Aba "Não lidas" do chat — filtro no servidor pra funcionar com paginação.
    if (filters.unread === '1' || filters.unread === 'true') {
      where.mensagens_nao_lidas = { gt: 0 };
    }
    if (filters.search) {
      const searchCondition = [
        { nome: { contains: filters.search, mode: 'insensitive' } },
        { telefone: { contains: filters.search } },
      ];
      mergeSearchCondition(where, searchCondition);
    }

    const cacheKey = this.buildLeadsListKey(user.tenantId, filters, user.role, user.id);
    const cached = await this.cache.get<unknown>(cacheKey);
    if (cached) return cached;

    const leadListSelect = {
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
      last_customer_message_at: true,
      last_agent_message_at: true,
      proximo_followup: true,
      cadence_step_index: true,
      created_at: true,
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
    } as const;

    const recencyOrder = [
      { ultima_interacao: { sort: 'desc', nulls: 'last' } },
      { created_at: 'desc' },
    ] as const;

    const runQuery = (extraWhere: Record<string, unknown>, take: number, skip: number) =>
      this.prisma.lead.findMany({
        relationLoadStrategy: 'join',
        where: { ...where, ...extraWhere },
        select: leadListSelect,
        // Chat/coluna: ordem pura de recência. Lista plena do kanban:
        // agrupada por estágio (agrupamento final é no cliente).
        orderBy:
          filters.scope === 'chat' || filters.estagio_id || filters.per_stage
            ? [...recencyOrder]
            : [{ estagio_id: 'asc' }, ...recencyOrder],
        take,
        skip,
      });

    type Row = Awaited<ReturnType<typeof runQuery>>[number];
    const mapRow = (lead: Row) => {
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
    };

    let result: unknown;

    if (filters.per_stage && filters.pipeline_id) {
      // F3: janela por coluna do kanban — top-N por estágio + contagem total
      // por estágio. Board de 2k+ leads deixa de baixar tudo de uma vez.
      const perStage = Math.min(parseInt(filters.per_stage) || 50, 500);
      const stages = await this.prisma.stage.findMany({
        where: { pipeline_id: filters.pipeline_id },
        select: { id: true },
      });
      const [lists, counts] = await Promise.all([
        Promise.all(stages.map((s) => runQuery({ estagio_id: s.id }, perStage, 0))),
        this.prisma.lead.groupBy({
          by: ['estagio_id'],
          where: where as Parameters<typeof this.prisma.lead.groupBy>[0]['where'],
          _count: { _all: true },
          _sum: { valor_estimado: true },
        }),
      ]);
      const stage_counts: Record<string, number> = {};
      const stage_values: Record<string, number> = {};
      for (const c of counts) {
        stage_counts[c.estagio_id] = c._count._all;
        stage_values[c.estagio_id] = Number(c._sum?.valor_estimado ?? 0);
      }
      result = { leads: lists.flat().map(mapRow), stage_counts, stage_values };
    } else {
      const leads = await runQuery(
        {},
        // Chat pagina de verdade (default 60); lista plena mantém cap 10k.
        filters.limit
          ? Math.min(parseInt(filters.limit), 10000)
          : filters.scope === 'chat'
            ? 60
            : 10000,
        filters.offset ? parseInt(filters.offset) : 0,
      );
      result = leads.map(mapRow);
    }

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
    // Lead privado só é acessível pelo responsável atual — vale pra todos
    // os papéis. Bloqueia gerente/super-admin de abrir conversa que outro
    // gestor já assumiu.
    if (lead.is_private && lead.responsavel_id !== user.id) {
      throw new ForbiddenException('Lead privado');
    }
    if (
      user.role === UserRole.OPERADOR ||
      user.role === UserRole.VISUALIZADOR
    ) {
      const ownedInstances = await this.getOwnedInstanceNames(user.id, user.tenantId);
      const accessible = lead.responsavel_id === user.id ||
        (lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp));
      if (!accessible) throw new ForbiddenException();
    }
    return lead;
  }

  async remove(id: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true },
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

    // Compute initial position so new leads append at the bottom of the stage.
    let initialPosition = 1000;
    if (parsed.estagio_id) {
      const maxResult = await this.prisma.lead.aggregate({
        where: { estagio_id: parsed.estagio_id, tenant_id: user.tenantId },
        _max: { position: true },
      });
      const maxPos = maxResult._max.position;
      if (maxPos !== null && maxPos !== undefined) {
        initialPosition = maxPos + 1000;
      }
    }

    const tenant = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { pool_enabled: true },
    });

    const [lead] = await this.prisma.$transaction([
      this.prisma.lead.create({
        data: {
          ...parsed,
          responsavel_id: parsed.responsavel_id || (tenant?.pool_enabled ? null : user.id),
          // Escopo de identidade: SEMPRE tenant → 1 lead por telefone+pipeline
          // (pool e Individual). Evita duplicar o mesmo contato por dono.
          lead_scope: user.tenantId,
          origem: 'MANUAL',
          tenant_id: user.tenantId,
          position: initialPosition,
        },
      }),
    ]);

    await this.prisma.leadActivity.create({
      data: {
        lead_id: lead.id,
        user_id: user.id,
        tipo: 'lead_created',
        descricao: 'Lead criado manualmente',
        tenant_id: user.tenantId,
      },
    });

    await this.invalidateLeadsCache(user.tenantId);

    this.outboundWebhooks.dispatchLeadEvent({
      tenantId: user.tenantId,
      eventType: 'lead.created',
      leadId: lead.id,
    }).catch(err => this.logger.warn(`dispatch lead.created: ${String(err)}`));

    return lead;
  }

  async update(id: string, data: unknown, user: AuthUser) {
    const parsed = updateLeadSchema.parse(data);

    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: {
        id: true,
        responsavel_id: true,
        nome: true,
        telefone: true,
        email: true,
        temperatura: true,
        valor_estimado: true,
        tags: true,
        dados_custom: true,
      },
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
    if (parsed.dados_custom !== undefined) {
      // Valida contra as definições ativas e MESCLA com o existente (patch
      // parcial — enviar um campo não apaga os demais).
      const validated = await this.customFields.validateValues(
        parsed.dados_custom,
        user.tenantId,
      );
      updateData.dados_custom = {
        ...((lead.dados_custom as Record<string, unknown> | null) ?? {}),
        ...validated,
      };
    }

    // Detect which fields actually changed for the activity log.
    const changedFields: string[] = [];
    const dadosAntes: Record<string, string | number | boolean | null> = {};
    const dadosDepois: Record<string, string | number | boolean | null> = {};
    for (const key of Object.keys(updateData)) {
      const oldVal = (lead as Record<string, unknown>)[key];
      const newVal = updateData[key];
      // JSON.stringify handles arrays (tags) and null comparison
      if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        changedFields.push(key);
        dadosAntes[key] = JSON.parse(JSON.stringify(oldVal ?? null));
        dadosDepois[key] = JSON.parse(JSON.stringify(newVal ?? null));
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.lead.update({
        where: { id },
        data: updateData,
        include: {
          responsavel: { select: { id: true, nome: true, avatar_url: true } },
          estagio: true,
          pipeline: true,
          lead_tags: { include: { tag: true } },
        },
      });

      if (changedFields.length > 0) {
        const FIELD_LABELS: Record<string, string> = {
          nome: 'Nome',
          telefone: 'Telefone',
          email: 'Email',
          temperatura: 'Temperatura',
          valor_estimado: 'Valor estimado',
          responsavel_id: 'Responsavel',
          tags: 'Tags',
        };
        const descricao = changedFields
          .map((f) => FIELD_LABELS[f] ?? f)
          .join(', ') + ' atualizado(s)';

        await tx.leadActivity.create({
          data: {
            lead_id: id,
            user_id: user.id,
            tipo: 'lead_updated',
            descricao,
            dados_antes: dadosAntes,
            dados_depois: dadosDepois,
            tenant_id: user.tenantId,
          },
        });
      }

      return result;
    });

    await this.invalidateLeadsCache(user.tenantId);

    try {
      this.gateway.emitLeadUpdated(id, { leadId: id, triggeredByUserId: user.id }, user.tenantId);
    } catch (err) {
      this.logger.warn(`emitLeadUpdated failed for lead ${id}: ${String(err)}`);
    }

    if (changedFields.length > 0) {
      this.outboundWebhooks.dispatchLeadEvent({
        tenantId: user.tenantId,
        eventType: 'lead.updated',
        leadId: id,
        changes: { fields: changedFields, before: dadosAntes, after: dadosDepois },
      }).catch(err => this.logger.warn(`dispatch lead.updated: ${String(err)}`));
    }

    return updated;
  }

  async updateStage(id: string, data: unknown, user: AuthUser) {
    const { estagio_id, position } = updateStageSchema.parse(data);

    const lead = await this.prisma.lead.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!lead) throw new NotFoundException();

    const stageChanged = estagio_id !== lead.estagio_id;

    if (!stageChanged) {
      // Position-only reorder within the same stage — no activity, no auto-actions, no estagio_entered_at reset.
      const updateData: { position?: number } = {};
      if (position !== undefined) updateData.position = position;
      const updatedLead = await this.prisma.lead.update({
        where: { id },
        data: updateData,
      });
      await this.invalidateLeadsCache(user.tenantId);
      return updatedLead;
    }

    const leadUpdateData: { estagio_id: string; estagio_entered_at: Date; position?: number } = {
      estagio_id,
      estagio_entered_at: new Date(),
    };
    if (position !== undefined) leadUpdateData.position = position;

    // Fetch stage names for a readable activity description.
    const [oldStage, newStage] = await Promise.all([
      this.prisma.stage.findUnique({ where: { id: lead.estagio_id }, select: { nome: true } }),
      this.prisma.stage.findUnique({ where: { id: estagio_id }, select: { nome: true } }),
    ]);
    const descricao = oldStage && newStage
      ? `Movido de "${oldStage.nome}" para "${newStage.nome}"`
      : 'Movido para novo estagio';

    const isSystem = user.id === 'SYSTEM';
    const activityUserId = isSystem ? null : user.id;
    const [updatedLead] = await this.prisma.$transaction([
      this.prisma.lead.update({
        where: { id },
        data: leadUpdateData,
      }),
      this.prisma.leadActivity.create({
        data: {
          lead_id: id,
          user_id: activityUserId,
          tipo: 'stage_change',
          descricao: isSystem ? `[Automação SLA] ${descricao}` : descricao,
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

    {
      const newStageMeta = await this.prisma.stage.findUnique({
        where: { id: estagio_id },
        select: { is_won: true, is_lost: true },
      });
      const eventType: 'deal.won' | 'deal.lost' | 'lead.updated' =
        newStageMeta?.is_won ? 'deal.won'
        : newStageMeta?.is_lost ? 'deal.lost'
        : 'lead.updated';
      this.outboundWebhooks.dispatchLeadEvent({
        tenantId: user.tenantId,
        eventType,
        leadId: id,
        changes: { from_stage_id: lead.estagio_id, to_stage_id: estagio_id },
      }).catch(err => this.logger.warn(`dispatch ${eventType}: ${String(err)}`));
    }

    // Fire-and-forget enqueue of stage auto-actions; failure must not break the move.
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

    return updatedLead;
  }

  async bulkMoveStage(data: unknown, user: AuthUser) {
    const { ids, estagio_id } = bulkMoveStageSchema.parse(data);
    const where: Record<string, unknown> = {
      id: { in: ids },
      tenant_id: user.tenantId,
    };
    if (user.role === UserRole.OPERADOR) {
      where.responsavel_id = user.id;
    }
    // TODO: enqueue auto-actions for bulk move (skipped to avoid N queue jobs)
    // TODO: skip logging individual LeadActivity records for bulk (expensive)
    const result = await this.prisma.lead.updateMany({
      where,
      data: { estagio_id, estagio_entered_at: new Date() },
    });
    await this.invalidateLeadsCache(user.tenantId);
    return { updated: result.count };
  }

  async bulkAssign(data: unknown, user: AuthUser) {
    if (user.role === UserRole.OPERADOR) {
      throw new ForbiddenException('Operadores nao podem reatribuir leads em massa');
    }
    const { ids, responsavel_id } = bulkAssignSchema.parse(data);
    const result = await this.prisma.lead.updateMany({
      where: { id: { in: ids }, tenant_id: user.tenantId },
      data: { responsavel_id },
    });
    await this.invalidateLeadsCache(user.tenantId);
    return { updated: result.count };
  }

  async bulkTag(data: unknown, user: AuthUser) {
    const { ids, tag } = bulkTagSchema.parse(data);
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: ids }, tenant_id: user.tenantId },
      select: { id: true, tags: true, responsavel_id: true },
    });
    const accessible = user.role === UserRole.OPERADOR
      ? leads.filter((l) => l.responsavel_id === null || l.responsavel_id === user.id)
      : leads;
    const skipped = leads.length - accessible.length;
    if (skipped > 0) {
      this.logger.debug(`bulkTag: ${skipped} leads skipped (ownership filter) for user ${user.id}`);
    }
    await this.prisma.$transaction(
      accessible.map((lead) => {
        const existing: string[] = Array.isArray(lead.tags) ? (lead.tags as string[]) : [];
        const next = existing.includes(tag) ? existing : [...existing, tag];
        return this.prisma.lead.update({ where: { id: lead.id }, data: { tags: next } });
      }),
    );
    await this.invalidateLeadsCache(user.tenantId);
    return { updated: accessible.length, skipped };
  }

  async bulkArchive(data: unknown, user: AuthUser) {
    const { ids } = bulkIdsSchema.parse(data);
    const where: Record<string, unknown> = {
      id: { in: ids },
      tenant_id: user.tenantId,
    };
    if (user.role === UserRole.OPERADOR) {
      where.responsavel_id = user.id;
    }
    const leadsToDelete = await this.prisma.lead.findMany({
      where,
      select: { id: true },
    });
    await this.prisma.$transaction(
      leadsToDelete.map((lead) => this.prisma.lead.delete({ where: { id: lead.id } })),
    );
    await this.invalidateLeadsCache(user.tenantId);
    return { archived: leadsToDelete.length };
  }

  private async findOwnedInstance(userId: string, tenantId: string) {
    return this.prisma.whatsappInstance.findFirst({
      where: { owner_user_id: userId, tenant_id: tenantId },
      orderBy: [{ ultimo_check: 'desc' }, { created_at: 'desc' }],
    });
  }

  async claim(leadId: string, user: AuthUser) {
    // assumed_at marca o momento da posse — getMessages usa pra esconder
    // o histórico anterior. Sem isso, o novo responsável veria msgs que
    // não eram pra ele.
    // Privacidade no claim depende do papel:
    //  - GERENTE/SUPER_ADMIN: privatiza (outros managers param de ver — regra
    //    "se o gerente/super-admin assumir, ninguém pode ter acesso").
    //  - OPERADOR: NÃO privatiza, pra que managers continuem supervisionando
    //    o trabalho da equipe pelo Kanban.
    const isManagerClaim =
      (roleHierarchy[user.role] ?? 0) >= roleHierarchy[UserRole.GERENTE];
    const result = await this.prisma.lead.updateMany({
      where: { id: leadId, tenant_id: user.tenantId, responsavel_id: { equals: null } },
      data: {
        responsavel_id: user.id,
        assumed_at: new Date(),
        is_private: isManagerClaim,
      },
    });
    if (result.count === 0) {
      throw new ConflictException('Lead ja atribuido ou nao encontrado');
    }
    const ownedInstance = await this.findOwnedInstance(user.id, user.tenantId);
    if (ownedInstance) {
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { instancia_whatsapp: ownedInstance.nome },
      });
    }
    await this.invalidateLeadsCache(user.tenantId);
    this.gateway.emitLeadUpdated(
      leadId,
      { responsavel_id: user.id, ...(ownedInstance ? { instancia_whatsapp: ownedInstance.nome } : {}) },
      user.tenantId,
    );
    return { id: leadId, responsavel_id: user.id, instancia_whatsapp: ownedInstance?.nome };
  }

  async reassign(leadId: string, body: unknown, user: AuthUser) {
    const { novoResponsavelId } = reassignSchema.parse(body);

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // Auth: precisa ser o responsável atual OU role >= GERENTE.
    // Leads do pool (responsavel_id === null) só podem ser pegos via /claim, não /reassign.
    const isOwner = lead.responsavel_id === user.id;
    const isManager = (roleHierarchy[user.role] ?? 0) >= roleHierarchy[UserRole.GERENTE];
    if (!isOwner && !isManager) {
      throw new ForbiddenException('Apenas o responsavel atual ou gerentes podem reatribuir');
    }

    const newUser = await this.prisma.user.findFirst({
      where: { id: novoResponsavelId, tenant_id: user.tenantId, ativo: true },
      select: { id: true, role: true },
    });
    if (!newUser) {
      throw new BadRequestException('Usuario destino nao encontrado, inativo ou de outro tenant');
    }
    if ((roleHierarchy[newUser.role] ?? 0) < roleHierarchy[UserRole.OPERADOR]) {
      throw new BadRequestException('Nao e possivel atribuir lead a um VISUALIZADOR');
    }

    const ownedInstance = await this.findOwnedInstance(novoResponsavelId, user.tenantId);
    const updated = await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        responsavel_id: novoResponsavelId,
        // Reseta assumed_at — novo responsável começa do zero, sem histórico
        // do anterior. Msgs antigas continuam no DB com visible_to_user_id
        // do dono anterior, então só ele ainda enxerga (privacidade).
        assumed_at: new Date(),
        ...(ownedInstance ? { instancia_whatsapp: ownedInstance.nome } : {}),
      },
      select: { id: true, nome: true },
    });
    await this.invalidateLeadsCache(user.tenantId);
    this.gateway.emitLeadUpdated(
      leadId,
      { responsavel_id: novoResponsavelId, ...(ownedInstance ? { instancia_whatsapp: ownedInstance.nome } : {}) },
      user.tenantId,
    );
    void this.push.sendToUsers([novoResponsavelId], {
      title: 'Novo lead atribuido',
      body: `${updated.nome} foi transferido para voce`,
      url: `/leads/${leadId}`,
      tag: `reassign-${leadId}`,
      data: { leadId, type: 'reassign' },
    });
    return { id: leadId, responsavel_id: novoResponsavelId, instancia_whatsapp: ownedInstance?.nome };
  }

  /**
   * Move a conversa para um setor e redistribui em round-robin entre os
   * agentes ativos daquele setor (mesma fila A,B,A,B do webhook de entrada —
   * compartilha QueuePointer/AssignmentLog via AssignmentService).
   *
   * Ex.: setor "Atacado" com Adjaine e Romilda → 1º lead p/ Adjaine, 2º p/
   * Romilda, 3º p/ Adjaine, etc. O ponteiro é único por setor: chamadas manuais
   * e automáticas avançam a MESMA fila.
   *
   * Setor sem agentes ativos → lead volta ao pool (espera), supervisores avisados.
   */
  async moveToSector(leadId: string, body: unknown, user: AuthUser) {
    const { sectorId } = moveToSectorSchema.parse(body);

    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true, nome: true, responsavel_id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // Auth: responsável atual OU gerente+ (espelha reassign/returnToPool).
    const isOwner = lead.responsavel_id === user.id;
    const isManager = (roleHierarchy[user.role] ?? 0) >= roleHierarchy[UserRole.GERENTE];
    if (!isOwner && !isManager) {
      throw new ForbiddenException('Apenas o responsavel atual ou gerentes podem mover de setor');
    }

    const sector = await this.prisma.sector.findFirst({
      where: { id: sectorId, tenant_id: user.tenantId, active: true },
      select: { id: true, name: true },
    });
    if (!sector) throw new BadRequestException('Setor nao encontrado, inativo ou de outro tenant');

    // Round-robin: escolhe o próximo agente do setor e avança o ponteiro.
    const result = await this.assignment.assignBySector(user.tenantId, sectorId, leadId);

    if (!result.userId) {
      // Sem agentes ativos: lead em espera no pool.
      await this.prisma.lead.update({
        where: { id: leadId },
        data: { responsavel_id: null, assumed_at: null, is_private: false },
      });
      await this.prisma.leadActivity.create({
        data: {
          lead_id: leadId,
          user_id: user.id,
          tipo: 'MOVED_TO_SECTOR',
          descricao: `Movido para o setor ${sector.name} (sem agentes ativos — em espera)`,
          dados_antes: { responsavel_id: lead.responsavel_id },
          dados_depois: { sector_id: sectorId, responsavel_id: null },
          tenant_id: user.tenantId,
        },
      });
      await this.invalidateLeadsCache(user.tenantId);
      this.gateway.emitLeadUpdated(leadId, { responsavel_id: null }, user.tenantId);
      return { id: leadId, sector_id: sectorId, responsavel_id: null, reason: result.reason };
    }

    const ownedInstance = await this.findOwnedInstance(result.userId, user.tenantId);
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        responsavel_id: result.userId,
        // Novo responsável começa do zero (sem histórico do anterior).
        assumed_at: new Date(),
        is_private: false,
        ...(ownedInstance ? { instancia_whatsapp: ownedInstance.nome } : {}),
      },
    });
    await this.prisma.leadActivity.create({
      data: {
        lead_id: leadId,
        user_id: user.id,
        tipo: 'MOVED_TO_SECTOR',
        descricao: `Movido para o setor ${sector.name} (round-robin)`,
        dados_antes: { responsavel_id: lead.responsavel_id },
        dados_depois: { sector_id: sectorId, responsavel_id: result.userId },
        tenant_id: user.tenantId,
      },
    });
    await this.invalidateLeadsCache(user.tenantId);
    this.gateway.emitLeadUpdated(
      leadId,
      { responsavel_id: result.userId, ...(ownedInstance ? { instancia_whatsapp: ownedInstance.nome } : {}) },
      user.tenantId,
    );
    void this.push.sendToUsers([result.userId], {
      title: 'Novo lead atribuido',
      body: `${lead.nome} foi distribuido para voce (${sector.name})`,
      url: `/leads/${leadId}`,
      tag: `sector-${leadId}`,
      data: { leadId, type: 'move-to-sector' },
    });
    return {
      id: leadId,
      sector_id: sectorId,
      responsavel_id: result.userId,
      instancia_whatsapp: ownedInstance?.nome,
      reason: result.reason,
    };
  }

  async returnToPool(leadId: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (lead.responsavel_id === null) {
      return { id: leadId, responsavel_id: null };
    }
    const isOwner = lead.responsavel_id === user.id;
    const isManager = (roleHierarchy[user.role] ?? 0) >= roleHierarchy[UserRole.GERENTE];
    if (!isOwner && !isManager) {
      throw new ForbiddenException('Apenas o responsavel atual ou gerentes podem devolver ao escritorio');
    }

    await this.prisma.lead.update({
      where: { id: leadId },
      // Volta pro pool: zera assumed_at, libera privacidade. Msgs antigas
      // continuam protegidas pelo visible_to_user_id do dono anterior.
      data: { responsavel_id: null, assumed_at: null, is_private: false },
    });
    await this.prisma.leadActivity.create({
      data: {
        lead_id: leadId,
        user_id: user.id,
        tipo: 'RETURNED_TO_POOL',
        descricao: `Lead devolvido ao escritorio por ${user.nome}`,
        dados_antes: { responsavel_id: lead.responsavel_id },
        dados_depois: { responsavel_id: null },
        tenant_id: user.tenantId,
      },
    });
    await this.invalidateLeadsCache(user.tenantId);
    this.gateway.emitLeadUpdated(leadId, { responsavel_id: null }, user.tenantId);
    return { id: leadId, responsavel_id: null };
  }

  async getMessages(leadId: string, user: AuthUser, cursor?: string, limit = 50) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: {
        id: true,
        responsavel_id: true,
        instancia_whatsapp: true,
        assumed_at: true,
        is_private: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    const isManager =
      (roleHierarchy[user.role] ?? 0) >= roleHierarchy[UserRole.GERENTE];

    // Lead privado: só o responsável atual lê msgs. Privacidade total após
    // claim de manager — nem outros managers veem.
    if (lead.is_private && lead.responsavel_id !== user.id) {
      return { messages: [], nextCursor: undefined };
    }
    // Manager (GERENTE/SUPER_ADMIN) vê msgs de qualquer lead não-privado
    // sem filtro por instância nem por assumed_at — supervisão completa.
    // Operador segue restrito a leads onde é responsável OU da própria
    // instância (Individual).
    const isResponsavel = lead.responsavel_id === user.id;
    let ownedInstances: string[] = [];
    if (!isManager) {
      ownedInstances = await this.getOwnedInstanceNames(user.id, user.tenantId);
      const accessible = isResponsavel ||
        (lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp));
      if (!accessible) {
        return { messages: [], nextCursor: undefined };
      }
    }
    // Histórico antes do claim só é escondido pra OPERADOR; manager sempre
    // tem visão completa. Tenant com share_history_enabled (ex.: Diplapel)
    // desliga o corte: quem recebe o lead transferido vê a conversa inteira
    // pra ter contexto e dar sequência.
    const tenantCfg = await this.prisma.tenant.findFirst({
      where: { id: user.tenantId },
      select: { share_history_enabled: true },
    });
    const hideHistory =
      !isManager && !!lead.assumed_at && !tenantCfg?.share_history_enabled;
    // Dono do lead vê a conversa INTEIRA, mesmo trechos que entraram por outro
    // número (cliente que falou com mais de uma instância). O filtro por
    // instância só vale pra quem acessa via instância própria SEM ser o
    // responsável — aí limita ao que passou pelo número dele.
    const filterByInstance = !isManager && !isResponsavel && ownedInstances.length > 0;
    const rows = await this.prisma.message.findMany({
      where: {
        lead_id: leadId,
        tenant_id: user.tenantId,
        ...(filterByInstance
          ? { instance_name: { in: ownedInstances } }
          : {}),
        ...(hideHistory
          ? {
              OR: [
                { created_at: { gte: lead.assumed_at as Date } },
                { visible_to_user_id: user.id },
              ],
            }
          : {}),
      },
      orderBy: { created_at: 'desc' },
      take: limit + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const messages = await Promise.all(
      sliced.map(async (m) => ({
        ...m,
        media_url: await this.resolveMediaUrl(m.media_url),
      })),
    );
    return {
      messages,
      nextCursor: hasMore ? messages[messages.length - 1].id : undefined,
    };
  }

  async getActivities(leadId: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true, responsavel_id: true, instancia_whatsapp: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    if (user.role === UserRole.OPERADOR) {
      const ownedInstances = await this.getOwnedInstanceNames(user.id, user.tenantId);
      const accessible = lead.responsavel_id === user.id ||
        (lead.instancia_whatsapp && ownedInstances.includes(lead.instancia_whatsapp));
      if (!accessible) return [];
    }
    return this.prisma.leadActivity.findMany({
      where: { lead_id: leadId, tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      take: 100,
      select: {
        id: true,
        tipo: true,
        descricao: true,
        dados_antes: true,
        dados_depois: true,
        created_at: true,
        user: { select: { id: true, nome: true } },
      },
    });
  }

  async exportCsv(user: AuthUser, filters: ExportLeadFilters, res: Response): Promise<void> {
    const where: Record<string, unknown> = { tenant_id: user.tenantId };

    if (user.role === UserRole.OPERADOR) {
      where.responsavel_id = user.id;
    }

    if (filters.pipeline_id) where.pipeline_id = filters.pipeline_id;
    if (filters.estagio_id) where.estagio_id = filters.estagio_id;
    if (filters.responsavel_id) where.responsavel_id = filters.responsavel_id;
    if (filters.temperatura) where.temperatura = filters.temperatura;
    if (filters.from || filters.to) {
      const createdAt: Record<string, Date> = {};
      if (filters.from) createdAt.gte = new Date(filters.from);
      if (filters.to) createdAt.lte = new Date(filters.to);
      where.created_at = createdAt;
    }

    const leads = await this.prisma.lead.findMany({
      where,
      select: {
        id: true,
        nome: true,
        telefone: true,
        email: true,
        temperatura: true,
        valor_estimado: true,
        mensagens_nao_lidas: true,
        ultima_interacao: true,
        created_at: true,
        tags: true,
        pipeline: { select: { nome: true } },
        estagio: { select: { nome: true } },
        responsavel: { select: { nome: true } },
      },
      orderBy: { created_at: 'desc' },
      take: 10000,
    });

    const headers = [
      'id',
      'nome',
      'telefone',
      'email',
      'temperatura',
      'valor_estimado',
      'pipeline',
      'stage',
      'responsavel',
      'tags',
      'created_at',
      'ultima_interacao',
      'mensagens_nao_lidas',
    ];

    const rows = leads.map((l) => ({
      id: l.id,
      nome: l.nome,
      telefone: l.telefone,
      email: l.email,
      temperatura: l.temperatura,
      valor_estimado: l.valor_estimado,
      pipeline: l.pipeline.nome,
      stage: l.estagio.nome,
      responsavel: l.responsavel?.nome ?? '',
      tags: Array.isArray(l.tags) ? (l.tags as string[]).join(';') : '',
      created_at: l.created_at,
      ultima_interacao: l.ultima_interacao,
      mensagens_nao_lidas: l.mensagens_nao_lidas,
    }));

    const csv = toCsv(rows, headers);
    const timestamp = Date.now();
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="leads-${timestamp}.csv"`);
    res.send(csv);
  }

  /**
   * F-03: liga/desliga a trava da IA na conversa. blocked=false reabre a IA
   * (a integração volta a responder); blocked=true trava manualmente.
   */
  async setAiBlocked(leadId: string, body: unknown, user: AuthUser) {
    const { blocked } = z.object({ blocked: z.boolean() }).parse(body);
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');
    await this.prisma.lead.update({ where: { id: leadId }, data: { ai_blocked: blocked } });
    await this.invalidateLeadsCache(user.tenantId);
    try {
      this.gateway.emitLeadUpdated(leadId, { ai_blocked: blocked }, user.tenantId);
    } catch (err) {
      this.logger.warn(`emitLeadUpdated (ai_blocked) failed for lead ${leadId}: ${String(err)}`);
    }
    return { ok: true, ai_blocked: blocked };
  }

  async markAsRead(leadId: string, user: AuthUser) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: user.tenantId },
      select: {
        id: true,
        telefone: true,
        instancia_whatsapp: true,
      },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    // IDs das msgs ainda não-lidas — precisamos antes do update pra mandar
    // ack pro WhatsApp. Sem isso, o check azul não aparece no celular nativo
    // do remetente (WhatsApp Web infere via presence; mobile não).
    const unreadIncoming = await this.prisma.message.findMany({
      where: {
        lead_id: leadId,
        direction: 'INCOMING',
        status: { not: 'READ' },
        whatsapp_message_id: { not: null },
      },
      select: { whatsapp_message_id: true },
    });
    const messageIds = unreadIncoming
      .map((m) => m.whatsapp_message_id)
      .filter((id): id is string => !!id);

    await this.prisma.lead.update({
      where: { id: leadId },
      data: { mensagens_nao_lidas: 0 },
    });
    await this.prisma.message.updateMany({
      where: { lead_id: leadId, direction: 'INCOMING', status: { not: 'READ' } },
      data: { status: 'READ' },
    });
    await this.invalidateLeadsCache(user.tenantId);
    this.gateway.emitLeadUnreadReset(leadId, user.tenantId);

    // Dispara ack pro WhatsApp em background — não bloqueia a resposta HTTP.
    // Se a instância não tem token (offline ou removida), ignora silenciosamente.
    if (lead.instancia_whatsapp) {
      const instance = await this.prisma.whatsappInstance.findFirst({
        where: { nome: lead.instancia_whatsapp, tenant_id: user.tenantId },
        select: { config: true, nome: true },
      });
      const cfg = (instance?.config ?? {}) as InstanceConfig;
      if (cfg.provider === 'evolution') {
        const apikey = cfg.evolution_token;
        const baseUrl = cfg.evolution_base_url || process.env['EVOLUTION_BASE_URL'] || '';
        if (apikey && baseUrl && instance) {
          this.instances
            .markChatReadEvolution(baseUrl, apikey, instance.nome, lead.telefone, messageIds)
            .catch((err: unknown) =>
              this.logger.warn(
                `markChatRead Evolution falhou lead=${leadId}: ${String(err)}`,
              ),
            );
        }
      } else {
        const token = cfg.uazapi_token;
        if (token) {
          this.instances
            .markChatRead(token, lead.telefone, messageIds)
            .catch((err: unknown) =>
              this.logger.warn(
                `markChatRead UazAPI falhou lead=${leadId}: ${String(err)}`,
              ),
            );
        }
      }
    }
  }

  // ── Dedupe/merge ────────────────────────────────────────────────────────

  /**
   * Grupos de leads possivelmente duplicados no tenant: mesmo telefone
   * (últimos 8 dígitos, ignora 55/DDD/9 extra) ou mesmo e-mail. GERENTE+.
   */
  async findDuplicates(user: AuthUser) {
    const groups = await this.prisma.$queryRaw<
      Array<{ chave: string; criterio: string; ids: string[] }>
    >`
      SELECT RIGHT(regexp_replace(telefone, '\\D', '', 'g'), 8) AS chave,
             'telefone' AS criterio,
             array_agg(id ORDER BY created_at ASC) AS ids
      FROM "Lead"
      WHERE tenant_id = ${user.tenantId}
        AND length(regexp_replace(telefone, '\\D', '', 'g')) >= 8
      GROUP BY 1
      HAVING COUNT(*) > 1
      UNION ALL
      SELECT lower(email) AS chave,
             'email' AS criterio,
             array_agg(id ORDER BY created_at ASC) AS ids
      FROM "Lead"
      WHERE tenant_id = ${user.tenantId} AND email IS NOT NULL AND email <> ''
      GROUP BY 1
      HAVING COUNT(*) > 1
      LIMIT 50
    `;
    if (groups.length === 0) return { groups: [] };

    const allIds = [...new Set(groups.flatMap((g) => g.ids))];
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: allIds }, tenant_id: user.tenantId },
      select: {
        id: true,
        nome: true,
        telefone: true,
        email: true,
        foto_url: true,
        valor_estimado: true,
        created_at: true,
        ultima_interacao: true,
        responsavel: { select: { id: true, nome: true } },
        estagio: { select: { id: true, nome: true, cor: true } },
        _count: { select: { messages: true } },
      },
    });
    const byId = new Map(leads.map((l) => [l.id, l]));
    return {
      groups: groups
        .map((g) => ({
          criterio: g.criterio,
          chave: g.chave,
          leads: g.ids.map((id) => byId.get(id)).filter(Boolean),
        }))
        .filter((g) => g.leads.length > 1),
    };
  }

  /**
   * Merge: move mensagens/atividades/tarefas/tags do source pro target,
   * preenche campos vazios do target com os do source e apaga o source.
   * Histórico preservado (padrão HubSpot/Pipedrive). GERENTE+.
   */
  async mergeLeads(targetId: string, body: unknown, user: AuthUser) {
    const { source_id } = z.object({ source_id: z.string().uuid() }).parse(body);
    if (source_id === targetId) {
      throw new BadRequestException('source e target sao o mesmo lead');
    }
    const [target, source] = await Promise.all([
      this.prisma.lead.findFirst({ where: { id: targetId, tenant_id: user.tenantId } }),
      this.prisma.lead.findFirst({ where: { id: source_id, tenant_id: user.tenantId } }),
    ]);
    if (!target || !source) throw new NotFoundException('Lead nao encontrado');

    await this.prisma.$transaction(async (tx) => {
      await tx.message.updateMany({
        where: { lead_id: source_id },
        data: { lead_id: targetId },
      });
      await tx.leadActivity.updateMany({
        where: { lead_id: source_id },
        data: { lead_id: targetId },
      });
      await tx.task.updateMany({
        where: { lead_id: source_id },
        data: { lead_id: targetId },
      });
      // Tags: move só as que o target ainda não tem (evita violar unicidade).
      const targetTags = await tx.leadTag.findMany({
        where: { lead_id: targetId },
        select: { tag_id: true },
      });
      const targetTagIds = new Set(targetTags.map((t) => t.tag_id));
      const sourceTags = await tx.leadTag.findMany({
        where: { lead_id: source_id },
        select: { id: true, tag_id: true },
      });
      const movable = sourceTags.filter((t) => !targetTagIds.has(t.tag_id)).map((t) => t.id);
      if (movable.length) {
        await tx.leadTag.updateMany({
          where: { id: { in: movable } },
          data: { lead_id: targetId },
        });
      }

      // Campos: target ganha o que estiver vazio; contadores somam.
      await tx.lead.update({
        where: { id: targetId },
        data: {
          email: target.email ?? source.email,
          empresa: target.empresa ?? source.empresa,
          cargo: target.cargo ?? source.cargo,
          foto_url: target.foto_url ?? source.foto_url,
          whatsapp_lid: target.whatsapp_lid ?? source.whatsapp_lid,
          valor_estimado: target.valor_estimado ?? source.valor_estimado,
          mensagens_nao_lidas:
            (target.mensagens_nao_lidas ?? 0) + (source.mensagens_nao_lidas ?? 0),
          ultima_interacao:
            source.ultima_interacao && target.ultima_interacao
              ? new Date(
                  Math.max(
                    source.ultima_interacao.getTime(),
                    target.ultima_interacao.getTime(),
                  ),
                )
              : (target.ultima_interacao ?? source.ultima_interacao),
        },
      });

      await tx.lead.delete({ where: { id: source_id } });

      await tx.leadActivity.create({
        data: {
          lead_id: targetId,
          user_id: user.id,
          tipo: 'lead_merged',
          descricao: `Lead "${source.nome}" (${source.telefone}) mesclado neste`,
          dados_antes: { source_id, source_nome: source.nome, source_telefone: source.telefone },
          tenant_id: user.tenantId,
        },
      });
    });

    await this.invalidateLeadsCache(user.tenantId);
    this.gateway.emitLeadUpdated(targetId, { merged_from: source_id }, user.tenantId);
    return { id: targetId, merged_source_id: source_id };
  }
}
