import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BroadcastMode, BroadcastStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

export interface CreateBroadcastInput {
  name: string;
  stage_id?: string | null;
  mode: BroadcastMode;
  template?: string | null;
  ai_instruction?: string | null;
  model_config_id?: string | null;
  throttle_seconds?: number;
  respect_ai_block?: boolean;
  temperatura?: string | null; // filtro de segmento opcional
}

/**
 * Follow-up / broadcast por IA: cria um disparo segmentado (por etapa) e gera os
 * alvos (BroadcastTarget). O envio real, com throttle, é feito pelo
 * BroadcastDispatcher (cron). O CRUD aqui é multi-tenant via tenant_id.
 */
@Injectable()
export class BroadcastsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(user: AuthUser) {
    const rows = await this.prisma.broadcast.findMany({
      where: { tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { targets: true } } },
    });
    return rows;
  }

  async get(user: AuthUser, id: string) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    const counts = await this.prisma.broadcastTarget.groupBy({
      by: ['status'],
      where: { broadcast_id: id },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const c of counts) byStatus[c.status] = c._count._all;
    return { ...b, target_counts: byStatus };
  }

  /**
   * Preview dos alvos: lista os leads que o disparo vai atingir, com nome,
   * dono (responsável) e se está bloqueado pela IA — pro front mostrar a
   * confirmação ANTES do Play. Evita a surpresa de mandar pra lead de outro
   * dono que não aparece no Kanban filtrado do criador.
   */
  async targets(user: AuthUser, id: string) {
    const b = await this.prisma.broadcast.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true, respect_ai_block: true },
    });
    if (!b) throw new NotFoundException('Broadcast não encontrado');

    const rows = await this.prisma.broadcastTarget.findMany({
      where: { broadcast_id: id },
      orderBy: { created_at: 'asc' },
      select: { lead_id: true, status: true },
    });
    const leadIds = rows.map((r) => r.lead_id);
    const leads = await this.prisma.lead.findMany({
      where: { id: { in: leadIds }, tenant_id: user.tenantId },
      select: { id: true, nome: true, telefone: true, responsavel_id: true, ai_blocked: true },
    });
    const leadById = new Map(leads.map((l) => [l.id, l]));

    const respIds = [...new Set(leads.map((l) => l.responsavel_id).filter((x): x is string => !!x))];
    const owners = await this.prisma.user.findMany({
      where: { id: { in: respIds } },
      select: { id: true, nome: true },
    });
    const ownerById = new Map(owners.map((o) => [o.id, o.nome]));

    return rows.map((r) => {
      const lead = leadById.get(r.lead_id);
      return {
        lead_id: r.lead_id,
        nome: lead?.nome ?? '(lead removido)',
        telefone: lead?.telefone ?? null,
        responsavel_nome: lead?.responsavel_id ? ownerById.get(lead.responsavel_id) ?? null : null,
        ai_blocked: b.respect_ai_block ? (lead?.ai_blocked ?? false) : false,
        status: r.status,
      };
    });
  }

  async create(user: AuthUser, dto: CreateBroadcastInput) {
    if (dto.mode === 'template' && !dto.template?.trim()) {
      throw new BadRequestException('template é obrigatório no modo template');
    }
    if (dto.mode === 'ai' && !dto.ai_instruction?.trim()) {
      throw new BadRequestException('ai_instruction é obrigatório no modo ai');
    }

    // Seleciona os leads do segmento (por etapa e/ou temperatura).
    const leads = await this.prisma.lead.findMany({
      where: {
        tenant_id: user.tenantId,
        ...(dto.stage_id ? { estagio_id: dto.stage_id } : {}),
        ...(dto.temperatura ? { temperatura: dto.temperatura as never } : {}),
      },
      select: { id: true },
    });
    if (leads.length === 0) {
      throw new BadRequestException('Nenhum lead no segmento selecionado');
    }

    return this.prisma.broadcast.create({
      data: {
        tenant_id: user.tenantId,
        name: dto.name.trim(),
        stage_id: dto.stage_id ?? null,
        segment: dto.temperatura ? { temperatura: dto.temperatura } : undefined,
        mode: dto.mode,
        template: dto.template ?? null,
        ai_instruction: dto.ai_instruction ?? null,
        model_config_id: dto.model_config_id ?? null,
        throttle_seconds: dto.throttle_seconds ?? 300,
        respect_ai_block: dto.respect_ai_block ?? true,
        created_by: user.id,
        targets: { create: leads.map((l) => ({ lead_id: l.id })) },
      },
      include: { _count: { select: { targets: true } } },
    });
  }

  private async setStatus(user: AuthUser, id: string, status: BroadcastStatus, allowedFrom: BroadcastStatus[]) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    if (!allowedFrom.includes(b.status)) {
      throw new BadRequestException(`Transição inválida de ${b.status} para ${status}`);
    }
    return this.prisma.broadcast.update({ where: { id }, data: { status } });
  }

  start(user: AuthUser, id: string) {
    return this.setStatus(user, id, BroadcastStatus.running, [BroadcastStatus.draft, BroadcastStatus.paused]);
  }

  pause(user: AuthUser, id: string) {
    return this.setStatus(user, id, BroadcastStatus.paused, [BroadcastStatus.running]);
  }

  cancel(user: AuthUser, id: string) {
    return this.setStatus(user, id, BroadcastStatus.canceled, [
      BroadcastStatus.draft,
      BroadcastStatus.running,
      BroadcastStatus.paused,
    ]);
  }
}
