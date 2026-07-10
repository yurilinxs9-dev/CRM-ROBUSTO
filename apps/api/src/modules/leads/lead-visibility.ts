import { UserRole } from '@/common/types/roles';

/**
 * Regras de visibilidade de leads — função PURA, sem Prisma/IO, para ser
 * testável em isolamento. O leads.service monta o `where` final a partir daqui.
 *
 * Modos (decididos por tenant.pool_enabled):
 * - COMPARTILHADO (pool=true): conversa no pool (sem responsável) é de todos;
 *   assumida vira só do responsável. GERENTE/SUPER_ADMIN supervisionam tudo,
 *   exceto lead privado de outro responsável.
 * - INDIVIDUAL (pool=false): cada um vê só as próprias. No scope=chat isso vale
 *   pra QUALQUER role (anti-leak Cajuru: supervisão global só no Kanban/lista).
 */
export interface VisibilityInput {
  userId: string;
  role: UserRole;
  poolEnabled: boolean;
  /** 'chat' restringe gerentes no modo individual. */
  scope?: string;
}

export type LeadWhere = Record<string, unknown>;

export function isManagerRole(role: UserRole): boolean {
  return role === UserRole.GERENTE || role === UserRole.SUPER_ADMIN;
}

/** Condições de visibilidade a mesclar no `where` da listagem de leads. */
export function buildVisibilityWhere(input: VisibilityInput): LeadWhere {
  const { userId, role, poolEnabled, scope } = input;
  const where: LeadWhere = {};

  if (poolEnabled) {
    if (isManagerRole(role)) {
      where.OR = [{ is_private: false }, { responsavel_id: userId }];
    } else {
      where.OR = [
        { responsavel_id: null, is_private: false },
        { responsavel_id: userId },
      ];
    }
    return where;
  }

  // INDIVIDUAL
  if (
    role === UserRole.OPERADOR ||
    role === UserRole.VISUALIZADOR ||
    scope === 'chat'
  ) {
    where.responsavel_id = userId;
  }
  where.OR = [{ is_private: false }, { responsavel_id: userId }];
  return where;
}

/**
 * Mescla condição de busca textual num `where` que pode já carregar um OR de
 * visibilidade: nesse caso vira AND [{OR visibilidade}, {OR busca}] pra não
 * furar a visibilidade.
 */
export function mergeSearchCondition(
  where: LeadWhere,
  searchCondition: unknown[],
): LeadWhere {
  if (where.OR) {
    where.AND = [{ OR: where.OR }, { OR: searchCondition }];
    delete where.OR;
  } else {
    where.OR = searchCondition;
  }
  return where;
}
