import type { UserRole } from '@prisma/client';

export interface AuthUser {
  id: string;
  nome: string;
  email: string;
  role: UserRole;
  ativo: boolean;
  tenantId: string;
}
