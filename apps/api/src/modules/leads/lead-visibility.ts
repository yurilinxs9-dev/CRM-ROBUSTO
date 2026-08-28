import { UserRole } from '@/common/types/roles';

/**
 * Regras de visibilidade de leads — função PURA, sem Prisma/IO, para ser
 * testável em isolamento. O leads.service monta o `where` final a partir daqui.
 *
 * Modos (decididos por tenant.pool_enabled):
 * - COMPARTILHADO (pool=true): conversa no pool (sem responsável) é de todos;
 *   assumida vira só do responsável. GERENTE/SUPER_ADMIN supervisionam tudo,
 *   exceto lead privado de outro responsável.
 * - INDIVIDUAL (pool=false): cada um vê as próprias + a NUVEM de devolvidos
 *   (sem dono e com `returned_at` preenchido — lead novo sem dono fica invisível,
 *   quem distribui é o gerente). No scope=chat vale só-as-próprias pra QUALQUER
 *   role (anti-leak Cajuru: supervisão global e nuvem só no Kanban/lista).
 *
 * MODO FOCO (`User.focus_mode`): gerente/super admin abrem mão da supervisão e
 * enxergam como operador — as próprias, mais os sem-dono, porque distribuir
 * continua sendo papel deles mesmo atendendo a própria carteira.
 */
export interface VisibilityInput {
  userId: string;
  role: UserRole;
  poolEnabled: boolean;
  /**
   * 'chat' restringe TODO role aos próprios no modo individual.
   * 'radar' restringe só quem NÃO é manager (gerente segue supervisionando).
   */
  scope?: string;
  /** Gerente+ com modo foco: enxerga como operador, mais os sem-dono p/ distribuir. */
  focusMode?: boolean;
}

export type LeadWhere = Record<string, unknown>;

export function isManagerRole(role: UserRole): boolean {
  return role === UserRole.GERENTE || role === UserRole.SUPER_ADMIN;
}

/** Condições de visibilidade a mesclar no `where` da listagem de leads. */
export function buildVisibilityWhere(input: VisibilityInput): LeadWhere {
  const { userId, role, poolEnabled, scope, focusMode } = input;
  const where: LeadWhere = {};
  const supervising = isManagerRole(role) && !focusMode;

  if (poolEnabled) {
    if (supervising) {
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
  if (scope === 'chat' || (scope === 'radar' && !isManagerRole(role))) {
    // Anti-leak Cajuru: no chat todo mundo vê só as próprias conversas —
    // supervisão global (e nuvem) só no Kanban/lista.
    // 'radar': insights de SUPERVISÃO da própria carteira — a nuvem fica fora
    // (lead sem dono não é tarefa de ninguém) e o foco do gerente
    // deliberadamente NÃO afeta o Radar, que segue mostrando o time inteiro.
    where.responsavel_id = userId;
    return where;
  }
  if (supervising) {
    where.OR = [{ is_private: false }, { responsavel_id: userId }];
    return where;
  }
  if (isManagerRole(role)) {
    // Foco: os próprios + QUALQUER sem-dono (novo ou devolvido) — distribuir
    // continua sendo papel do gerente mesmo atendendo a própria carteira.
    where.OR = [
      { responsavel_id: userId },
      { responsavel_id: null, is_private: false },
    ];
    return where;
  }
  // OPERADOR/VISUALIZADOR: os próprios + nuvem (só DEVOLVIDOS; lead novo sem
  // dono fica invisível — quem distribui é o gerente).
  where.OR = [
    { responsavel_id: userId },
    { responsavel_id: null, returned_at: { not: null }, is_private: false },
  ];
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
