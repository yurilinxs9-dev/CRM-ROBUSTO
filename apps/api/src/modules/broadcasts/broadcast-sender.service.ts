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

export type DispatchOutcome = 'sent' | 'skipped' | 'failed';

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
  private readonly sysUserCache = new Map<string, AuthUser | null>();

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
   * Dispara um alvo. `force` (envio manual) ignora o pulo por ai_block/etapa —
   * o humano escolheu aquele lead explicitamente.
   */
  async sendToTarget(
    b: DispatchBroadcast,
    target: { id: string; lead_id: string },
    opts: { force?: boolean } = {},
  ): Promise<{ outcome: DispatchOutcome; detail?: string }> {
    // O código vem junto do texto: o texto explica o caso, o código é o que
    // soma no painel. Aqui ele é explícito, não inferido — quem pula sabe o
    // motivo melhor do que qualquer classificador de string.
    const skip = async (
      error: string,
      code: BroadcastErrorCode,
    ): Promise<{ outcome: DispatchOutcome; detail: string }> => {
      await this.prisma.broadcastTarget.update({
        where: { id: target.id },
        data: { status: 'skipped', error, error_code: code },
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
        estagio_id: true,
        responsavel: { select: { nome: true } },
      },
    });

    if (!lead || !lead.telefone) return skip('lead inválido/sem telefone', 'sem_telefone');
    // Snapshot da criação: se o lead saiu da etapa alvo, o follow-up daquela
    // etapa não vale mais pra ele (exceto envio manual forçado).
    if (!opts.force && b.stage_id && lead.estagio_id !== b.stage_id) {
      return skip('lead saiu da etapa alvo', 'fora_da_etapa');
    }
    if (!opts.force && b.respect_ai_block && lead.ai_blocked) {
      return skip('ai_blocked (humano no atendimento)', 'atendimento_humano');
    }

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

    // F-03: follow-up é cadência → sender_type 'system' (não bloqueia a IA).
    await this.messages.sendText({ lead_id: lead.id, content }, sysUser, { senderType: 'system' });
    await this.prisma.broadcastTarget.update({
      where: { id: target.id },
      data: { status: 'sent', sent_at: new Date(), error: null },
    });
    return { outcome: 'sent' };
  }

  async getTenantSystemUser(tenantId: string): Promise<AuthUser | null> {
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
