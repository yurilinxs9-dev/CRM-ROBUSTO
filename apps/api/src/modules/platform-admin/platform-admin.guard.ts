import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { PLATFORM_SCOPE_KEY, type PlatformScope } from './platform-scopes.decorator';

/**
 * Libera apenas usuários com is_platform_admin=true (verificado no banco, não
 * no JWT — assim revogar o acesso tem efeito imediato) E que tenham o escopo
 * exigido pela rota. Escopo '*' libera tudo; rota sem @PlatformScopes exige '*'.
 * Usar SEMPRE após o JwtAuthGuard (que popula req.user).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('Não autenticado');

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { is_platform_admin: true, ativo: true, platform_scopes: true },
    });
    if (!dbUser?.is_platform_admin || !dbUser.ativo) {
      throw new ForbiddenException('Acesso restrito ao admin de plataforma');
    }

    const scopes = dbUser.platform_scopes ?? [];
    if (scopes.includes('*')) return true;

    const required = this.reflector.getAllAndOverride<PlatformScope | undefined>(PLATFORM_SCOPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (required && scopes.includes(required)) return true;

    throw new ForbiddenException('Acesso restrito ao admin de plataforma');
  }
}
