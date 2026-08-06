import { SetMetadata } from '@nestjs/common';

/**
 * Áreas do painel de plataforma que podem ser concedidas separadamente.
 *
 * O coringa '*' (admin master) fica DE FORA do type de propósito: ele é um
 * valor possível em `User.platform_scopes`, nunca um argumento válido de
 * `@PlatformScopes(...)`. Assim ninguém decora uma rota com '*' por engano —
 * a rota do master é a rota SEM decorator (fail-closed).
 */
export type PlatformScope =
  | 'overview'
  | 'tenants'
  | 'tenant_actions'
  | 'health'
  | 'logs'
  | 'announcements'
  | 'ai';

export const PLATFORM_SCOPE_KEY = 'platform_scope';

/**
 * Declara o escopo exigido por uma rota (ou por todo um controller). Rota SEM
 * este decorator só é liberada para quem tem o coringa '*' — fail-closed, para
 * que uma rota nova nasça restrita ao admin master.
 */
export const PlatformScopes = (scope: PlatformScope) => SetMetadata(PLATFORM_SCOPE_KEY, scope);
