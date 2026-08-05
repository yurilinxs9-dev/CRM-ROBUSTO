import { SetMetadata } from '@nestjs/common';

/** Áreas do painel de plataforma que podem ser concedidas separadamente. */
export type PlatformScope = 'health' | 'announcements' | 'ai';

export const PLATFORM_SCOPE_KEY = 'platform_scope';

/**
 * Declara o escopo exigido por uma rota (ou por todo um controller). Rota SEM
 * este decorator só é liberada para quem tem o coringa '*' — fail-closed, para
 * que uma rota nova nasça restrita ao admin master.
 */
export const PlatformScopes = (scope: PlatformScope) => SetMetadata(PLATFORM_SCOPE_KEY, scope);
