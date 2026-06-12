import type { ApiScope } from './scopes';

/**
 * Contexto de autenticação resolvido pelo ApiKeyGuard e anexado em `req.apiAuth`.
 * É o equivalente público do `AuthUser` (que vem do JWT no app interno), mas
 * escopado por tenant + API key — não por usuário.
 */
export interface ApiAuth {
  keyId: string;
  tenantId: string;
  scopes: ApiScope[];
  /** F-03: chave marcada como serviço de IA → mensagens enviadas como
   *  sender_type='ai' e sujeitas à trava ai_blocked. Default false = 'system'. */
  isAi: boolean;
}
