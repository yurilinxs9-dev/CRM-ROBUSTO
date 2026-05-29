import { SetMetadata } from '@nestjs/common';

/**
 * Escopos suportados pela API pública (/api/v1). Cada API key carrega um
 * subconjunto destes; o ScopesGuard valida por rota via @RequireScopes().
 */
export const API_SCOPES = [
  'contacts:read',
  'contacts:write',
  'conversations:read',
  'conversations:write',
  'tags:write',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export const SCOPES_KEY = 'api_required_scopes';

/** Marca uma rota como exigindo um ou mais escopos de API key. */
export const RequireScopes = (...scopes: ApiScope[]) => SetMetadata(SCOPES_KEY, scopes);
