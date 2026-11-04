import type { Prisma } from '@prisma/client';

/**
 * Marca no `WhatsappInstance.config` (JSON, sem migration): lead que chega
 * neste número vai direto para o dono (`owner_user_id`), em qualquer modo do
 * tenant. Gravada pelo gestor ao definir o responsável do número.
 */
export const DIRECT_TO_OWNER_KEY = 'direct_to_owner';

export function isDirectToOwner(config: Prisma.JsonValue | null | undefined): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    !Array.isArray(config) &&
    (config as Prisma.JsonObject)[DIRECT_TO_OWNER_KEY] === true
  );
}
