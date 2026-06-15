import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MessagesService } from '../messages/messages.service';
import { AiProviderService } from '../ai/ai-provider.service';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Motor de envio do follow-up/broadcast. Roda a cada minuto e, para cada
 * broadcast 'running', dispara NO MÁXIMO um alvo por janela de throttle
 * (throttle_seconds) — garantindo o espaçamento pedido (ex.: 1 msg a cada 5 min).
 *
 * - Modo template: substitui {{nome}} no texto fixo.
 * - Modo ai: gera a mensagem por lead via AiProviderService (feature followup).
 * Mensagens vão como sender_type='system' (cadência) e pulam leads ai_blocked
 * quando respect_ai_block=true.
 */
@Injectable()
export class BroadcastDispatcher {
  private readonly logger = new Logger(BroadcastDispatcher.name);
  private readonly sysUserCache = new Map<string, AuthUser | null>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly messages: MessagesService,
    private readonly ai: AiProviderService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async tick() {
    const now = new Date();
    const running = await this.prisma.broadcast.findMany({ where: { status: 'running' } });

    for (const b of running) {
      // Throttle: só dispara se passou throttle_seconds desde o último envio.
      if (b.last_dispatch_at) {
        const elapsed = (now.getTime() - b.last_dispatch_at.getTime()) / 1000;
        if (elapsed < b.throttle_seconds) continue;
      }

      const target = await this.prisma.broadcastTarget.findFirst({
        where: { broadcast_id: b.id, status: 'pending' },
        orderBy: { created_at: 'asc' },
      });

      if (!target) {
        await this.prisma.broadcast.update({ where: { id: b.id }, data: { status: 'done' } });
        continue;
      }

      try {
        await this.dispatchOne(b, target);
      } catch (err) {
        this.logger.error(`Broadcast ${b.id} alvo ${target.id} falhou: ${String(err)}`);
        await this.prisma.broadcastTarget.update({
          where: { id: target.id },
          data: { status: 'failed', error: String(err).slice(0, 500) },
        });
      }

      // Consome a janela de throttle independentemente do resultado do alvo.
      await this.prisma.broadcast.update({ where: { id: b.id }, data: { last_dispatch_at: new Date() } });
    }
  }

  private async dispatchOne(
    b: { id: string; tenant_id: string; mode: string; template: string | null; ai_instruction: string | null; model_config_id: string | null; respect_ai_block: boolean },
    target: { id: string; lead_id: string },
  ) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: target.lead_id, tenant_id: b.tenant_id },
      select: { id: true, nome: true, telefone: true, empresa: true, ai_blocked: true },
    });

    if (!lead || !lead.telefone) {
      await this.prisma.broadcastTarget.update({ where: { id: target.id }, data: { status: 'skipped', error: 'lead inválido/sem telefone' } });
      return;
    }
    if (b.respect_ai_block && lead.ai_blocked) {
      await this.prisma.broadcastTarget.update({ where: { id: target.id }, data: { status: 'skipped', error: 'ai_blocked (humano no atendimento)' } });
      return;
    }

    const sysUser = await this.getTenantSystemUser(b.tenant_id);
    if (!sysUser) {
      await this.prisma.broadcastTarget.update({ where: { id: target.id }, data: { status: 'failed', error: 'tenant sem admin/gerente ativo' } });
      return;
    }

    const content = await this.buildContent(b, lead);
    if (!content.trim()) {
      await this.prisma.broadcastTarget.update({ where: { id: target.id }, data: { status: 'skipped', error: 'mensagem vazia' } });
      return;
    }

    // F-03: follow-up é cadência → sender_type 'system' (não bloqueia a IA).
    await this.messages.sendText({ lead_id: lead.id, content }, sysUser, { senderType: 'system' });
    await this.prisma.broadcastTarget.update({ where: { id: target.id }, data: { status: 'sent', sent_at: new Date() } });
  }

  private async buildContent(
    b: { mode: string; template: string | null; ai_instruction: string | null; model_config_id: string | null; tenant_id: string },
    lead: { id: string; nome: string; empresa: string | null },
  ): Promise<string> {
    if (b.mode === 'template') {
      return (b.template ?? '').replace(/\{\{\s*nome\s*\}\}/gi, lead.nome).replace(/\{\{\s*empresa\s*\}\}/gi, lead.empresa ?? '');
    }
    // mode ai
    const system =
      `Você escreve uma mensagem curta de follow-up no WhatsApp, em português, cordial e objetiva, ` +
      `personalizada para o lead. Responda APENAS com o texto da mensagem.\n\n` +
      `Lead: ${lead.nome}${lead.empresa ? ` (${lead.empresa})` : ''}\n\nInstrução: ${b.ai_instruction ?? ''}`;
    const result = await this.ai.chat({
      modelConfigId: b.model_config_id,
      feature: 'followup',
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: 'Gere a mensagem de follow-up.' },
      ],
      tenantId: b.tenant_id,
      leadId: lead.id,
    });
    return result.text.trim();
  }

  private async getTenantSystemUser(tenantId: string): Promise<AuthUser | null> {
    if (this.sysUserCache.has(tenantId)) return this.sysUserCache.get(tenantId) ?? null;
    const u = await this.prisma.user.findFirst({
      where: { tenant_id: tenantId, ativo: true, role: { in: ['SUPER_ADMIN', 'GERENTE'] } },
      orderBy: { created_at: 'asc' },
    });
    const auth = u
      ? ({ id: u.id, nome: u.nome, email: u.email, role: u.role, ativo: u.ativo, tenantId: u.tenant_id } as AuthUser)
      : null;
    this.sysUserCache.set(tenantId, auth);
    return auth;
  }
}
