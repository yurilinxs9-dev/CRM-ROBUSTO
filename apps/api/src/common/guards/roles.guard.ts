import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserRole } from '@/common/types/roles';
import { ROLES_KEY } from '../decorators/roles.decorator';

const roleHierarchy: Record<UserRole, number> = {
  SUPER_ADMIN: 4,
  GERENTE: 3,
  OPERADOR: 2,
  VISUALIZADOR: 1,
};

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<UserRole[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!requiredRoles) return true;

    const { user } = context.switchToHttp().getRequest();
    const hasRole = requiredRoles.some(
      (role) => roleHierarchy[user.role as UserRole] >= roleHierarchy[role],
    );
    if (!hasRole) throw new ForbiddenException('Permissao insuficiente');
    return true;
  }
}
