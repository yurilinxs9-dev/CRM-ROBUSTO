import { dispatchWaitReason } from './broadcast-gate';
import { resolveAudienceWhere, campaignOptions } from './broadcast-config';
import { classifyBroadcastError } from './broadcast-error';
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagesService } from '../messages/messages.service';
import { AiProviderService } from '../ai/ai-provider.service';
import { buildFollowupContent } from './followup-content';
import type { BroadcastErrorCode } from './broadcast-error';
import type { AuthUser } from '../../common/types/auth-user';

export interface DispatchBroadcast {
  id: string;
  tenant_id: string;
  mode: string;
  template: string | null;
  ai_instruction: string | null;
  model_config_id: string | null;
  respect_ai_block: boolean;
  stage_id: string | null;
}

export type DispatchOutcome = 'sent' | 'skipped' | 'failed' | 'deferred';

/** Meia-noite de HOJE no horário de Brasília (UTC-3 fixo, sem DST). */
export function startOfDayBrt(now = new Date()): Date {
  const brt = new Date(now.getTime() - 3 * 3600_000);
  brt.setUTCHours(0, 0, 0, 0);
  return new Date(brt.getTime() + 3 * 3600_000);
}

/**
 * Envio de UM alvo de follow-up — lógica única compartilhada entre o cron
 * (BroadcastDispatcher) e o envio manual "agora" (BroadcastsService.sendNow).
 * Garante que guardas (lead válido, etapa, ai_block), conteúdo e marcação de
 * status sejam idênticos nos dois caminhos.
 */
@Injectable()
export class BroadcastSenderService {
  private readonly logger = new Logger(BroadcastSenderService.name);


  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly ai: AiProviderService,
  ) {}

  /**
   * Quantos alvos deste broadcast já foram ENVIADOS hoje (dia BRT).
   * `replied` também conta: a mensagem SAIU — o cliente ter respondido depois
   * não devolve cota. Sem isso o limite diário afrouxaria na proporção da taxa
   * de resposta, e ele é uma das duas travas que protegem o número.
   */
  async sentToday(broadcastId: string): Promise<number> {
    return this.prisma.broadcastTarget.count({
      where: { broadcast_id: broadcastId, status: { in: ['sent', 'replied'] }, sent_at: { gte: startOfDayBrt() } },
    });
  }

  /**
   * Dispara um alvo após reservar cota e cadência. Nenhum caminho ignora as proteções.
   */
  async sendToTarget(
    b: DispatchBroadcast,
    target: { id: string; lead_id: string },
    _opts: { force?: boolean } = {},
  ): Promise<{ outcome: DispatchOutcome; detail?: string }> {
    // Atomic reservation shared by cron and manual sends. The tenant advisory
    // lock serializes quota/interval checks across API replicas, before queueing.
    const reservation = await this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${b.tenant_id}))`;
      const current = await tx.broadcast.findFirst({ where: { id: b.id, tenant_id: b.tenant_id } });
      if (!current) return { wait: 'Campanha não encontrada' };
      if (current.status !== 'running') return { wait: 'Campanha pausada' };
      const tenant = await tx.tenant.findUnique({ where: { id: b.tenant_id } });
      const now = new Date();
      const wait = dispatchWaitReason(current, tenant, now);
      if (wait) return { wait };
      const count = await tx.broadcastTarget.count({ where: { broadcast_id: b.id, sent_at: { gte: startOfDayBrt(now) } } });
      if (count >= current.daily_limit) return { wait: 'Limite diário da campanha atingido' };
      const total = await tx.broadcastTarget.count({ where: { broadcast: { tenant_id: b.tenant_id }, sent_at: { gte: startOfDayBrt(now) } } });
      if (total >= 200) return { wait: 'Limite total de 200 tentativas por dia da empresa atingido' };
      const recent = await tx.broadcast.findFirst({ where: { tenant_id: b.tenant_id, last_dispatch_at: { not: null } }, orderBy: { last_dispatch_at: 'desc' } });
      if (recent?.last_dispatch_at && now.getTime() - recent.last_dispatch_at.getTime() < Math.max(30, current.throttle_seconds, recent.throttle_seconds) * 1000) return { wait: 'Aguardando intervalo mínimo entre campanhas da empresa' };
      const claim = await tx.broadcastTarget.updateMany({
        where: { id: target.id, broadcast_id: b.id, lead_id: target.lead_id, status: 'pending', OR: [{ error_code: null }, { error_code: { not: 'dispatching' } }] },
        data: { error_code: 'dispatching', error: null, sent_at: now },
      });
      if (!claim.count) return { wait: 'Destinatário já processado ou retirado da fila' };
      await tx.broadcast.update({ where: { id: b.id }, data: { last_dispatch_at: now } });
      return { current };
    });
    if ('wait' in reservation) return { outcome: 'deferred', detail: reservation.wait };
    try {
      return await this.deliverReserved(reservation.current, target);
    } catch (error) {
      const aiConfigError = String(error).includes('Nenhum modelo de IA') || String(error).includes('Modelo de IA não encontrado');
      await this.prisma.broadcastTarget.updateMany({ where: { id: target.id, error_code: 'dispatching' }, data: aiConfigError
        ? { status: 'pending', error_code: null, error: null, sent_at: null }
        : { status: 'failed', error_code: classifyBroadcastError(error), error: String(error).slice(0, 500) } });
      throw error;
    }
  }

  private async deliverReserved(b: DispatchBroadcast & { segment: import('@prisma/client').Prisma.JsonValue | null; created_at: Date; status: string }, target: { id: string; lead_id: string }): Promise<{ outcome: DispatchOutcome; detail?: string }> {
    // O código vem junto do texto: o texto explica o caso, o código é o que
    // soma no painel. Aqui ele é explícito, não inferido — quem pula sabe o
    // motivo melhor do que qualquer classificador de string.
    const skip = async (
      error: string,
      code: BroadcastErrorCode,
    ): Promise<{ outcome: DispatchOutcome; detail: string }> => {
      await this.prisma.broadcastTarget.update({
        where: { id: target.id },
        data: { status: 'skipped', error, error_code: code, sent_at: null },
      });
      return { outcome: 'skipped', detail: error };
    };

    const lead = await this.prisma.lead.findFirst({
      where: { id: target.lead_id, tenant_id: b.tenant_id },
      select: {
        id: true,
        nome: true,
        telefone: true,
        empresa: true,
        ai_blocked: true,
        estagio_id: true, last_customer_message_at: true,
        responsavel: { select: { nome: true } },
      },
    });

    if (!lead || !lead.telefone) return skip('lead inválido/sem telefone', 'sem_telefone');
    if (b.respect_ai_block && lead.ai_blocked) {
      return skip('ai_blocked (humano no atendimento)', 'atendimento_humano');
    }

    if (lead.last_customer_message_at && lead.last_customer_message_at > b.created_at) return skip('cliente respondeu após a criação da campanha', 'cliente_ja_conversando');
    const options = campaignOptions(b.segment);
    const eligible = await this.prisma.lead.count({ where: { AND: [await resolveAudienceWhere(this.prisma, b.tenant_id, { ...options, exclude_closed: options.exclude_closed ?? false, stage_id: b.stage_id }), { id: lead.id }] } });
    if (!eligible) return skip('lead não pertence mais ao público escolhido', 'fora_da_etapa');

    const sysUser = await this.getTenantSystemUser(b.tenant_id);
    if (!sysUser) {
      await this.prisma.broadcastTarget.update({
        where: { id: target.id },
        data: { status: 'failed', error: 'tenant sem admin/gerente ativo', error_code: 'sem_remetente' },
      });
      return { outcome: 'failed', detail: 'tenant sem admin/gerente ativo' };
    }

    const content = await buildFollowupContent(this.ai, b, {
      id: lead.id,
      nome: lead.nome,
      empresa: lead.empresa,
      telefone: lead.telefone,
      responsavel_nome: lead.responsavel?.nome ?? null,
    });
    if (!content.trim()) return skip('mensagem vazia', 'mensagem_vazia');

    // Recheck after AI generation: a reply or pause can arrive while it runs.
    const active = await this.prisma.broadcastTarget.findFirst({ where: { id: target.id, status: 'pending', error_code: 'dispatching', broadcast: { status: b.status as import('@prisma/client').BroadcastStatus } } });
    const freshLead = await this.prisma.lead.findFirst({ where: { id: lead.id, tenant_id: b.tenant_id }, select: { last_customer_message_at: true, ai_blocked: true } });
    if (!active) {
      await this.prisma.broadcastTarget.updateMany({ where: { id: target.id, status: 'pending', error_code: 'dispatching' }, data: { error_code: null, sent_at: null } });
      return { outcome: 'deferred', detail: 'Campanha interrompida durante a preparação' };
    }
    if (!freshLead || (freshLead.last_customer_message_at && freshLead.last_customer_message_at > b.created_at)) return skip('cliente respondeu ou saiu da fila', 'cliente_ja_conversando');
    if (b.respect_ai_block && freshLead.ai_blocked) return skip('atendimento humano iniciado', 'atendimento_humano');

    const freshWindow = await this.prisma.tenant.findUnique({ where: { id: b.tenant_id } });
    const freshCampaign = await this.prisma.broadcast.findUnique({ where: { id: b.id } });
    if (!freshCampaign || dispatchWaitReason({ ...freshCampaign, last_dispatch_at: null }, freshWindow, new Date())) {
      await this.prisma.broadcastTarget.updateMany({ where: { id: target.id, status: 'pending', error_code: 'dispatching' }, data: { error_code: null, sent_at: null } });
      return { outcome: 'deferred', detail: 'Horário de envio encerrado ou campanha interrompida' };
    }

    // F-03: follow-up é cadência → sender_type 'system' (não bloqueia a IA).
    await this.messages.sendText({ lead_id: lead.id, content }, sysUser, { senderType: 'system' });
    await this.prisma.broadcastTarget.update({
      where: { id: target.id },
      data: { status: 'sent', sent_at: new Date(), error: null, error_code: null },
    });
    return { outcome: 'sent' };
  }

  async getTenantSystemUser(tenantId: string): Promise<AuthUser | null> {

    const u = await this.prisma.user.findFirst({
      where: { tenant_id: tenantId, ativo: true, role: { in: ['SUPER_ADMIN', 'GERENTE'] } },
      orderBy: { created_at: 'asc' },
    });
    const auth = u
      ? ({ id: u.id, nome: u.nome, email: u.email, role: u.role, ativo: u.ativo, tenantId: u.tenant_id } as AuthUser)
      : null;

    return auth;
  }
}
