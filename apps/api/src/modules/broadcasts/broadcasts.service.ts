import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { BroadcastMode, BroadcastStatus } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { buildFollowupContent } from './followup-content';
import { BroadcastSenderService, startOfDayBrt } from './broadcast-sender.service';
import { aggregateFailureReasons, type FailureRow } from './broadcast-error';
import type { AuthUser } from '../../common/types/auth-user';

import { resolveAudienceWhere, campaignOptions, type CampaignInput, type AudienceInput } from './broadcast-config';
export type CreateBroadcastInput = CampaignInput;
export type PreviewBroadcastInput = AudienceInput & Pick<CampaignInput, 'mode' | 'template' | 'ai_instruction' | 'model_config_id'>;

/**
 * Follow-up / broadcast por IA: cria um disparo segmentado (por etapa) e gera os
 * alvos (BroadcastTarget). O envio real, com throttle, é feito pelo
 * BroadcastDispatcher (cron). O CRUD aqui é multi-tenant via tenant_id.
 */
@Injectable()
export class BroadcastsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ai: AiProviderService,
    private readonly sender: BroadcastSenderService,
  ) {}

  async list(user: AuthUser) {
    const rows = await this.prisma.broadcast.findMany({
      where: { tenant_id: user.tenantId },
      orderBy: { created_at: 'desc' },
      include: { _count: { select: { targets: true } } },
    });
    if (rows.length === 0) return rows;

    // Contagem por status de todos os broadcasts do tenant em UMA query —
    // é o que alimenta a barra de progresso da listagem no front.
    const counts = await this.prisma.broadcastTarget.groupBy({
      by: ['broadcast_id', 'status'],
      where: { broadcast_id: { in: rows.map((r) => r.id) } },
      _count: { _all: true },
    });
    const byBroadcast = new Map<string, Record<string, number>>();
    for (const c of counts) {
      const m = byBroadcast.get(c.broadcast_id) ?? {};
      m[c.status] = c._count._all;
      byBroadcast.set(c.broadcast_id, m);
    }
    // Enviados HOJE (dia BRT) por broadcast — alimenta o "X/30 hoje" do front.
    // Mesma regra do sentToday(): 'replied' conta, senão o contador ANDARIA
    // PARA TRÁS durante o dia conforme os clientes respondem.
    const todayCounts = await this.prisma.broadcastTarget.groupBy({
      by: ['broadcast_id'],
      where: {
        broadcast_id: { in: rows.map((r) => r.id) },
        status: { in: ['sent', 'replied'] },
        sent_at: { gte: startOfDayBrt() },
      },
      _count: { _all: true },
    });
    const attempts = await this.prisma.broadcastTarget.groupBy({ by: ['broadcast_id'], where: { broadcast_id: { in: rows.map(r => r.id) }, sent_at: { gte: startOfDayBrt() } }, _count: { _all: true } });
    const attemptsByBroadcast = new Map(attempts.map(c => [c.broadcast_id, c._count._all]));
    const todayByBroadcast = new Map(todayCounts.map((c) => [c.broadcast_id, c._count._all]));
    // Motivo das falhas agrupado: a contagem sozinha não diz nada acionável —
    // "3 falhas" pode ser instância desconectada ou lead sem telefone, e a
    // decisão (reconectar vs corrigir cadastro) é oposta.
    const failureReasons = await this.prisma.broadcastTarget.groupBy({
      by: ['broadcast_id', 'error_code', 'error'],
      where: { broadcast_id: { in: rows.map((r) => r.id) }, status: 'failed' },
      _count: { _all: true },
    });
    const linhasPorBroadcast = new Map<string, FailureRow[]>();
    for (const f of failureReasons) {
      const linhas = linhasPorBroadcast.get(f.broadcast_id) ?? [];
      linhas.push({ error_code: f.error_code, error: f.error, _count: f._count._all });
      linhasPorBroadcast.set(f.broadcast_id, linhas);
    }
    const failuresByBroadcast = new Map<string, Record<string, number>>(
      [...linhasPorBroadcast].map(([id, linhas]) => [id, aggregateFailureReasons(linhas)]),
    );
    return rows.map((r) => ({
      ...r,
      target_counts: byBroadcast.get(r.id) ?? {},
      sent_today: todayByBroadcast.get(r.id) ?? 0,
      attempts_today: attemptsByBroadcast.get(r.id) ?? 0,
      failure_reasons: failuresByBroadcast.get(r.id) ?? {},
    }));
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
      select: { lead_id: true, status: true, error: true, sent_at: true, replied_at: true, error_code: true },
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
        error: r.error, sent_at: r.sent_at, replied_at: r.replied_at, error_code: r.error_code,
      };
    });
  }

  /**
   * Garante que o modo IA tem modelo utilizável ANTES de criar/iniciar. Sem
   * isso o erro só aparecia alvo-a-alvo no dispatcher (1/min), queimando o
   * broadcast inteiro em 'failed' silenciosamente.
   */
  private async ensureAiConfigured(modelConfigId?: string | null) {
    if (modelConfigId) {
      const cfg = await this.prisma.aiModelConfig.findFirst({
        where: { id: modelConfigId, active: true },
        select: { id: true },
      });
      if (!cfg) throw new BadRequestException('Modelo de IA selecionado não existe ou está inativo');
      return;
    }
    const def = await this.ai.getDefaultModel();
    if (!def) {
      throw new BadRequestException(
        'Nenhum modelo de IA configurado. Peça ao administrador para cadastrar um modelo em Admin → IA, ou use o modo de texto fixo (template).',
      );
    }
  }

  /** Seleciona os leads do segmento (por etapa e/ou temperatura). */
  private segmentWhere(user: AuthUser, dto: AudienceInput) {
    return resolveAudienceWhere(this.prisma, user.tenantId, dto);
  }

  async audience(user: AuthUser, dto: AudienceInput) {
    const where = await this.segmentWhere(user, dto);
    const [total, leads] = await Promise.all([
      this.prisma.lead.count({ where }),
      this.prisma.lead.findMany({ where, orderBy: { created_at: 'asc' }, take: 50,
        select: { id: true, nome: true, telefone: true, ai_blocked: true, responsavel: { select: { nome: true } } } }),
    ]);
    return { total, leads };
  }

  async update(user: AuthUser, id: string, dto: CreateBroadcastInput) {
    const data = await this.prepare(user, dto);
    return this.prisma.$transaction(async tx => {
      const locked = await tx.broadcast.updateMany({ where: { id, tenant_id: user.tenantId, status: 'draft' }, data: { name: dto.name } });
      if (!locked.count) throw new BadRequestException('Somente rascunhos podem ser editados. Duplique para criar uma nova campanha.');
      const touched = await tx.broadcastTarget.count({ where: { broadcast_id: id, OR: [{ sent_at: { not: null } }, { error_code: 'dispatching' }] } });
      if (touched) throw new BadRequestException('Este rascunho já possui envios. Duplique para editar.');
      await tx.broadcastTarget.deleteMany({ where: { broadcast_id: id } });
      return tx.broadcast.update({ where: { id }, data, include: { _count: { select: { targets: true } } } });
    });
  }

  async duplicate(user: AuthUser, id: string) {
    const b = await this.get(user, id);
    const { scheduled_at: _schedule, ...options } = campaignOptions(b.segment);
    return this.create(user, {
      ...options, name: `${b.name.slice(0, 110)} (cópia)`, stage_id: b.stage_id,
      mode: b.mode, template: b.template, ai_instruction: b.ai_instruction,
      model_config_id: b.model_config_id, throttle_seconds: b.throttle_seconds,
      daily_limit: b.daily_limit, respect_ai_block: b.respect_ai_block,
    });
  }

  async create(user: AuthUser, dto: CreateBroadcastInput) {
    return this.prisma.broadcast.create({ data: await this.prepare(user, dto), include: { _count: { select: { targets: true } } } });
  }

  private async prepare(user: AuthUser, dto: CreateBroadcastInput) {
    if (dto.mode === 'template' && !dto.template?.trim()) {
      throw new BadRequestException('template é obrigatório no modo template');
    }
    if (dto.mode === 'ai') {
      if (!dto.ai_instruction?.trim()) {
        throw new BadRequestException('ai_instruction é obrigatório no modo ai');
      }
      await this.ensureAiConfigured(dto.model_config_id);
    }

    const tenant = await this.prisma.tenant.findUnique({ where: { id: user.tenantId }, select: { broadcast_window_start: true, broadcast_window_end: true, broadcast_window_days: true } });
    if (!tenant) throw new BadRequestException('Empresa não encontrada');
    if (Math.max(dto.window_start ?? 0, tenant.broadcast_window_start) >= Math.min(dto.window_end ?? 24, tenant.broadcast_window_end) || !(dto.window_days ?? [1,2,3,4,5,6,7]).some(d => tenant.broadcast_window_days.includes(d))) {
      throw new BadRequestException('A programação precisa ter dias e horários em comum com a janela da empresa.');
    }

    // A seleção manual também respeita os filtros adicionais.
    const manualIds = dto.lead_ids?.length ? [...new Set(dto.lead_ids)] : null;
    const leads = await this.prisma.lead.findMany({ where: await this.segmentWhere(user, dto), select: { id: true } });
    if (leads.length === 0) {
      throw new BadRequestException(
        manualIds ? 'Nenhum lead válido na seleção' : 'Nenhum lead no segmento selecionado',
      );
    }

    return {
        tenant_id: user.tenantId,
        name: dto.name.trim(),
        // Mantém o filtro de etapa também para seleções manuais.
        stage_id: dto.stage_id ?? null,
        segment: JSON.parse(JSON.stringify({
          pipeline_id: dto.pipeline_id, responsavel_id: dto.responsavel_id,
          temperatura: dto.temperatura, tags: dto.tags, inactive_days: dto.inactive_days,
          exclude_closed: dto.exclude_closed ?? true, scheduled_at: dto.scheduled_at,
          window_start: dto.window_start, window_end: dto.window_end, window_days: dto.window_days,
          ...(manualIds ? { lead_ids: leads.map(l => l.id) } : {}),
        })) as import('@prisma/client').Prisma.InputJsonObject,
        mode: dto.mode,
        template: dto.template ?? null,
        ai_instruction: dto.ai_instruction ?? null,
        model_config_id: dto.model_config_id ?? null,
        throttle_seconds: dto.throttle_seconds ?? 900,
        daily_limit: dto.daily_limit ?? 30,
        respect_ai_block: dto.respect_ai_block ?? true,
        created_by: user.id,
        targets: { create: leads.map((l) => ({ lead_id: l.id })) },
    };
  }

  /** Envio manual obedece às mesmas reservas, horários e intervalos do cron. */
  async sendNow(user: AuthUser, id: string, leadId: string) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    if (b.status !== 'running') throw new BadRequestException('Inicie a campanha antes de enviar um destinatário.');
    if (b.mode === BroadcastMode.ai) await this.ensureAiConfigured(b.model_config_id);

    const sentToday = await this.sender.sentToday(b.id);
    if (sentToday >= b.daily_limit) {
      throw new BadRequestException(`Limite diário atingido (${b.daily_limit}/dia). Volta a enviar amanhã.`);
    }

    const target = await this.prisma.broadcastTarget.findFirst({
      where: { broadcast_id: id, lead_id: leadId, status: 'pending' },
    });
    if (!target) throw new BadRequestException('Lead não está na fila deste follow-up');

    const result = await this.sender.sendToTarget(b, target, { force: true });
    if (result.outcome !== 'sent') {
      throw new BadRequestException(`Não enviado: ${result.detail ?? result.outcome}`);
    }
    return { sent: true, sent_today: sentToday + 1, daily_limit: b.daily_limit };
  }

  /**
   * Gera um EXEMPLO de mensagem para um lead real do segmento, sem enviar nada.
   * Usa exatamente a mesma lógica de conteúdo do dispatcher — o que aparece no
   * preview é o que o lead receberia.
   */
  async preview(user: AuthUser, dto: PreviewBroadcastInput) {
    if (dto.mode === 'template' && !dto.template?.trim()) {
      throw new BadRequestException('Escreva a mensagem antes de gerar o exemplo');
    }
    if (dto.mode === 'ai') {
      if (!dto.ai_instruction?.trim()) {
        throw new BadRequestException('Escreva a instrução da IA antes de gerar o exemplo');
      }
      await this.ensureAiConfigured(dto.model_config_id);
    }

    const lead = await this.prisma.lead.findFirst({
      where: await this.segmentWhere(user, dto),
      orderBy: { updated_at: 'desc' },
      select: {
        id: true,
        nome: true,
        empresa: true,
        telefone: true,
        responsavel: { select: { nome: true } },
      },
    });
    if (!lead) throw new BadRequestException('Nenhum lead no segmento selecionado');

    const content = await buildFollowupContent(
      this.ai,
      {
        mode: dto.mode,
        template: dto.template ?? null,
        ai_instruction: dto.ai_instruction ?? null,
        model_config_id: dto.model_config_id ?? null,
        tenant_id: user.tenantId,
      },
      {
        id: lead.id,
        nome: lead.nome,
        empresa: lead.empresa,
        telefone: lead.telefone,
        responsavel_nome: lead.responsavel?.nome ?? null,
      },
    );
    return { lead_nome: lead.nome, content };
  }

  private async setStatus(user: AuthUser, id: string, status: BroadcastStatus, allowedFrom: BroadcastStatus[]) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    if (!allowedFrom.includes(b.status)) {
      throw new BadRequestException(`Transição inválida de ${b.status} para ${status}`);
    }
    const changed = await this.prisma.broadcast.updateMany({ where: { id, tenant_id: user.tenantId, status: { in: allowedFrom } }, data: { status } });
    if (!changed.count) throw new BadRequestException('A campanha mudou. Atualize a página e tente novamente.');
    return this.get(user, id);
  }

  async start(user: AuthUser, id: string) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    // Revalida o modelo no Play — pode ter sido removido/desativado depois da criação.
    if (b.mode === BroadcastMode.ai) await this.ensureAiConfigured(b.model_config_id);
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

  /**
   * Recoloca os alvos com falha na fila (failed → pending) e religa o disparo.
   * Serve pra recuperar broadcasts que falharam por config (ex.: IA sem modelo)
   * sem precisar recriar tudo.
   */
  async retryFailed(user: AuthUser, id: string) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    if (b.status === 'canceled') throw new BadRequestException('Campanha cancelada. Duplique para criar outra.');
    if (b.mode === BroadcastMode.ai) await this.ensureAiConfigured(b.model_config_id);

    return this.prisma.$transaction(async tx => {
      const resumed = await tx.broadcast.updateMany({
        where: { id, tenant_id: user.tenantId, status: { not: 'canceled' } },
        data: { status: BroadcastStatus.running },
      });
      if (!resumed.count) throw new BadRequestException('Campanha cancelada ou removida.');
      const reset = await tx.broadcastTarget.updateMany({
        where: { broadcast_id: id, status: 'failed', OR: [{ sent_at: null }, { sent_at: { lt: startOfDayBrt() } }] },
        data: { status: 'pending', error: null, error_code: null },
      });
      if (!reset.count) throw new BadRequestException('Nenhuma falha disponível para nova tentativa. Tentativas de hoje poderão ser repetidas amanhã, preservando a cota diária');
      return { retried: reset.count };
    });
  }

  /** Exclui broadcasts finalizados/rascunho (targets caem por cascade). */
  async remove(user: AuthUser, id: string) {
    const b = await this.prisma.broadcast.findFirst({ where: { id, tenant_id: user.tenantId } });
    if (!b) throw new NotFoundException('Broadcast não encontrado');
    const deletable: BroadcastStatus[] = [BroadcastStatus.draft, BroadcastStatus.done, BroadcastStatus.canceled];
    if (!deletable.includes(b.status)) {
      throw new BadRequestException('Pause ou cancele o follow-up antes de excluir');
    }
    const attemptsToday = await this.prisma.broadcastTarget.count({ where: { broadcast_id: id, sent_at: { gte: startOfDayBrt() } } });
    if (attemptsToday) throw new BadRequestException('Campanhas com tentativas hoje só podem ser excluídas amanhã, para preservar o limite diário.');
    await this.prisma.broadcast.delete({ where: { id } });
    return { deleted: true };
  }
}
