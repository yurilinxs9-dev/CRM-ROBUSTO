import type { Prisma } from '@prisma/client';

/**
 * Ordenação da lista de leads vinda da query string. Whitelist fechada
 * (espelha SORTABLE_FIELDS de lead-views.service.ts): campo fora dela NÃO é
 * erro — cai na ordenação padrão da tela, porque uma view salva com sort
 * antigo tem que continuar abrindo.
 */
const NULLABLE_SORT = [
  'ultima_interacao',
  'valor_estimado',
  'temperatura',
  'proximo_followup',
] as const;
const PLAIN_SORT = ['nome', 'created_at'] as const;

export function buildSortOrder(
  sort?: string,
  dir?: string,
): Prisma.LeadOrderByWithRelationInput | null {
  if (dir !== 'asc' && dir !== 'desc') return null;
  if ((PLAIN_SORT as readonly string[]).includes(sort ?? '')) {
    return { [sort as string]: dir } as Prisma.LeadOrderByWithRelationInput;
  }
  if ((NULLABLE_SORT as readonly string[]).includes(sort ?? '')) {
    return { [sort as string]: { sort: dir, nulls: 'last' } } as Prisma.LeadOrderByWithRelationInput;
  }
  return null;
}
