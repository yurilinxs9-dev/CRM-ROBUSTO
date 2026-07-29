import { AiProviderService } from '../ai/ai-provider.service';

export interface FollowupLead {
  id: string;
  nome: string;
  empresa: string | null;
  telefone?: string | null;
  /** Nome do responsável (atendente) — preenchido pelo chamador quando houver. */
  responsavel_nome?: string | null;
}

export interface FollowupContentInput {
  mode: string;
  template: string | null;
  ai_instruction: string | null;
  model_config_id: string | null;
  tenant_id: string;
}

/** Saudação por horário de Brasília (sem DST desde 2019 → UTC-3 fixo). */
export function saudacaoBrasilia(now = new Date()): string {
  const hourBrt = (now.getUTCHours() + 24 - 3) % 24;
  if (hourBrt < 5) return 'Boa noite';
  if (hourBrt < 12) return 'Bom dia';
  if (hourBrt < 18) return 'Boa tarde';
  return 'Boa noite';
}

/**
 * Variáveis suportadas no texto fixo — aceitas em `{nome}` E `{{nome}}`,
 * com/sem espaços, case-insensitive:
 *   {nome}          nome completo do lead
 *   {primeiro_nome} primeiro nome do lead
 *   {empresa}       empresa do lead (vazio se não tiver)
 *   {telefone}      telefone do lead
 *   {atendente}     nome do responsável pelo lead
 *   {saudacao}      "Bom dia"/"Boa tarde"/"Boa noite" (horário de Brasília)
 */
export function renderTemplate(template: string, lead: FollowupLead): string {
  const vars: Record<string, string> = {
    nome: lead.nome ?? '',
    primeiro_nome: (lead.nome ?? '').trim().split(/\s+/)[0] ?? '',
    empresa: lead.empresa ?? '',
    telefone: lead.telefone ?? '',
    atendente: lead.responsavel_nome ?? '',
    saudacao: saudacaoBrasilia(),
  };
  // {{var}} ou {var}, espaços opcionais, acento-insensível no "saudacao".
  return template.replace(
    /\{\{?\s*(nome|primeiro_nome|empresa|telefone|atendente|sauda[cç][aã]o)\s*\}?\}/gi,
    (_m, raw: string) => {
      const key = raw.toLowerCase().replace(/[çã]/g, (c) => (c === 'ç' ? 'c' : 'a'));
      return vars[key] ?? '';
    },
  );
}

/**
 * Gera o conteúdo da mensagem de follow-up para um lead — texto fixo renderizado
 * ou mensagem personalizada por IA. Usado pelo dispatcher (envio real), pelo
 * envio manual e pelo preview — o exemplo mostrado é fiel ao envio.
 */
export async function buildFollowupContent(
  ai: AiProviderService,
  b: FollowupContentInput,
  lead: FollowupLead,
): Promise<string> {
  if (b.mode === 'template') {
    return renderTemplate(b.template ?? '', lead);
  }
  const system =
    `Você escreve uma mensagem curta de follow-up no WhatsApp, em português, cordial e objetiva, ` +
    `personalizada para o lead. Responda APENAS com o texto da mensagem.\n\n` +
    `Lead: ${lead.nome}${lead.empresa ? ` (${lead.empresa})` : ''}\n\nInstrução: ${b.ai_instruction ?? ''}`;
  const result = await ai.chat({
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
