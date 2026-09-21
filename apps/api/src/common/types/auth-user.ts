import type { UserRole } from '@prisma/client';

export interface AuthUser {
  /** Verified platform owner acting in the financial workspace. */
  financeActorId?: string;
  id: string;
  nome: string;
  email: string;
  role: UserRole;
  ativo: boolean;
  tenantId: string;
}
