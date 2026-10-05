import { z } from 'zod';

const registration = z.object({
  nome: z.string().trim().min(2, 'Informe seu nome com pelo menos 2 caracteres.').max(100, 'O nome deve ter até 100 caracteres.'),
  email: z.string().trim().email('Informe um e-mail válido.'),
  senha: z.string().min(8, 'A senha precisa ter pelo menos 8 caracteres.').max(100, 'A senha deve ter até 100 caracteres.'),
  workspace: z.string().trim().max(100, 'O nome do workspace deve ter até 100 caracteres.'),
});

export function validateRegistration(nome: string, email: string, senha: string, workspace: string): string {
  const result = registration.safeParse({ nome, email, senha, workspace });
  return result.success ? '' : result.error.issues.map(i => i.message).join(' ');
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
}
const labels: Record<string, string> = { nome: 'Nome', email: 'E-mail', senha: 'Senha', telefone: 'Telefone', estagio_id: 'Etapa', pipeline_id: 'Funil', workspace_name: 'Workspace', dados_custom: 'Campos personalizados' };
function readable(message: string): string {
  return message.replace(/Invalid email/gi, 'Informe um e-mail válido').replace(/Required/g, 'Campo obrigatório')
    .replace(/String must contain at least (\d+) character\(s\)/g, 'Informe pelo menos $1 caracteres')
    .replace(/String must contain at most (\d+) character\(s\)/g, 'Informe no máximo $1 caracteres')
    .replace(/Invalid uuid/gi, 'Selecione uma opção válida');
}

export function formError(error: unknown, context: 'account' | 'lead'): string {
  const err = record(error);
  const response = record(err.response);
  const data = record(response.data);
  const status = Number(response.status);
  if (err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT') return 'O servidor demorou a responder. Confira se o cadastro foi concluído antes de tentar novamente.';
  if (!status && err.code === 'ERR_NETWORK') return 'Não foi possível conectar ao servidor. Verifique sua conexão e tente novamente.';
  if (status === 429) return 'Muitas tentativas em pouco tempo. Aguarde um minuto e tente novamente.';
  if (status >= 500) return 'O servidor não conseguiu concluir o cadastro. Tente novamente em instantes; se persistir, contate o suporte.';
  if (status === 409 && context === 'account') return 'Este e-mail já está cadastrado. Entre na sua conta ou use “Esqueci minha senha”.';
  if (Array.isArray(data.details)) {
    const details = data.details.map(value => {
      const detail = record(value);
      if (typeof detail.message !== 'string') return '';
      const path = Array.isArray(detail.path) ? detail.path.map(String) : [];
      const label = path.map(part => labels[part] ?? part).join(' → ');
      return `${label ? label + ': ' : ''}${readable(detail.message)}`;
    }).filter(Boolean);
    if (details.length) return details.join('; ');
  }
  if (Array.isArray(data.message)) {
    const messages = data.message.filter((m): m is string => typeof m === 'string');
    if (messages.length) return messages.map(readable).join('; ');
  }
  if (typeof data.message === 'string' && data.message.trim()) {
    if (data.message === 'Resource already exists') return 'Já existe um cadastro com esses dados. Confira os registros existentes.';
    return readable(data.message);
  }
  return 'Não foi possível concluir o cadastro. Tente novamente; se persistir, contate o suporte.';
}
