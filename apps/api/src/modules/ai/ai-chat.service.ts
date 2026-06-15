import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { AiConfigService } from './ai-config.service';
import { AiProviderService } from './ai-provider.service';
import type { AiChatMessage } from './ai.types';

const MAX_CONTEXT_MESSAGES = 20;

/**
 * Recursos de IA voltados ao atendente (não platform-admin):
 * - copilot: chat lateral que responde sobre o lead/operação.
 * - suggest: gera rascunho de resposta ao cliente (humano revisa e envia).
 *
 * Ambos respeitam os toggles globais do AiAgentConfig e nunca enviam mensagem
 * ao cliente — só devolvem texto pro app.
 */
@Injectable()
export class AiChatService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly provider: AiProviderService,
    private readonly aiConfig: AiConfigService,
  ) {}

  /** Monta um bloco de contexto do lead + histórico recente p/ o prompt. */
  private async buildLeadContext(tenantId: string, leadId: string): Promise<{ context: string; history: AiChatMessage[] }> {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: { id: true, nome: true, telefone: true, empresa: true, cargo: true, temperatura: true, origem: true },
    });
    if (!lead) throw new NotFoundException('Lead não encontrado');

    const messages = await this.prisma.message.findMany({
      where: { lead_id: leadId, tenant_id: tenantId },
      orderBy: { created_at: 'desc' },
      take: MAX_CONTEXT_MESSAGES,
      select: { content: true, direction: true, type: true, created_at: true },
    });
    messages.reverse(); // ordem cronológica

    const context = [
      `Lead: ${lead.nome}`,
      lead.empresa ? `Empresa: ${lead.empresa}` : null,
      lead.cargo ? `Cargo: ${lead.cargo}` : null,
      `Telefone: ${lead.telefone}`,
      `Temperatura: ${lead.temperatura}`,
      `Origem: ${lead.origem}`,
    ].filter(Boolean).join('\n');

    // Histórico vira mensagens user/assistant: entrada do cliente = 'user',
    // nossas saídas = 'assistant' (perspectiva do atendente/IA).
    const history: AiChatMessage[] = messages.map((m) => ({
      role: m.direction === 'INCOMING' ? 'user' : 'assistant',
      content: m.content ?? `[${m.type}]`,
    }));

    return { context, history };
  }

  private async systemPrompt(extra: string): Promise<string> {
    const agent = await this.aiConfig.getAgentConfig();
    const base = agent.system_prompt?.trim() || 'Você é um assistente de CRM em português do Brasil.';
    return `${base}\n\n${extra}`;
  }

  /** Copilot: chat livre do atendente, opcionalmente ancorado num lead. */
  async copilot(user: AuthUser, body: { lead_id?: string | null; messages: AiChatMessage[] }) {
    const agent = await this.aiConfig.getAgentConfig();
    if (!agent.copilot_enabled) throw new ForbiddenException('Copilot desativado pela plataforma');

    let leadBlock = '';
    if (body.lead_id) {
      const { context, history } = await this.buildLeadContext(user.tenantId, body.lead_id);
      leadBlock = `\n\nContexto do lead em foco:\n${context}\n\nHistórico recente da conversa:\n${history.map((h) => `${h.role === 'user' ? 'Cliente' : 'Nós'}: ${h.content}`).join('\n')}`;
    }

    const system = await this.systemPrompt(
      `Você é o copiloto interno do atendente. Ajude com resumos, análise do lead e sugestões. Responda de forma objetiva em português.${leadBlock}`,
    );

    const messages: AiChatMessage[] = [{ role: 'system', content: system }, ...body.messages];
    const result = await this.provider.chat({
      modelConfigId: agent.default_model_id,
      feature: 'copilot',
      messages,
      tenantId: user.tenantId,
      leadId: body.lead_id ?? null,
    });
    return { reply: result.text };
  }

  /** Sugere o próximo rascunho de resposta ao cliente (não envia). */
  async suggestReply(user: AuthUser, leadId: string) {
    const agent = await this.aiConfig.getAgentConfig();
    if (!agent.suggest_enabled) throw new ForbiddenException('Sugestão de resposta desativada pela plataforma');

    const { context, history } = await this.buildLeadContext(user.tenantId, leadId);
    const system = await this.systemPrompt(
      `Você escreve, em nome do atendente, o PRÓXIMO rascunho de resposta ao cliente no WhatsApp. ` +
      `Tom cordial e objetivo, em português. Responda APENAS com o texto da mensagem, sem aspas nem rótulos.\n\nDados do lead:\n${context}`,
    );

    const messages: AiChatMessage[] = [{ role: 'system', content: system }, ...history];
    // Garante que a última fala seja do cliente p/ o modelo continuar como atendente.
    if (messages[messages.length - 1]?.role !== 'user') {
      messages.push({ role: 'user', content: '(gere a próxima mensagem de follow-up adequada)' });
    }

    const result = await this.provider.chat({
      modelConfigId: agent.default_model_id,
      feature: 'suggest',
      messages,
      tenantId: user.tenantId,
      leadId,
    });
    return { suggestion: result.text.trim() };
  }
}
