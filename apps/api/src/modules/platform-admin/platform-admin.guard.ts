import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Libera apenas usuários com is_platform_admin=true (verificado no banco, não
 * no JWT — assim revogar o acesso tem efeito imediato). Usar SEMPRE após o
 * JwtAuthGuard (que popula req.user).
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{ user?: AuthUser }>();
    const userId = req.user?.id;
    if (!userId) throw new ForbiddenException('Não autenticado');

    const dbUser = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { is_platform_admin: true, ativo: true },
    });
    if (!dbUser?.is_platform_admin || !dbUser.ativo) {
      throw new ForbiddenException('Acesso restrito ao admin de plataforma');
    }
    return true;
  }
}
