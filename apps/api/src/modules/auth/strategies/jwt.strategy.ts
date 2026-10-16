import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { RedisCacheService } from '../../../common/cache/redis-cache.service';
import type { AuthUser } from '../../../common/types/auth-user';

/** TTL do cache do lookup de user por request. Desativar um usuário demora
 *  no máximo isso pra valer em todas as réplicas — troca aceitável por cortar
 *  1 roundtrip de banco POR REQUEST autenticada. */
const USER_CACHE_TTL_SECONDS = 10;

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    config: ConfigService,
    private prisma: PrismaService,
    private cache: RedisCacheService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string; role: string; tenantId: string }): Promise<AuthUser> {
    const cacheKey = `auth:user:${payload.sub}`;
    const cached = await this.cache.get<AuthUser & { ativo: boolean }>(cacheKey);
    // PL permissions can be switched during an existing session. Read its
    // current profile from the database rather than a racing cache refill.
    if (cached && cached.tenantId !== 'a44772ed-1382-4400-84fc-3fa350e23e42') {
      if (!cached.ativo) throw new UnauthorizedException();
      return cached;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, nome: true, email: true, role: true, ativo: true, tenant_id: true, pl_sales_only: true },
    });
    if (!user || !user.ativo) throw new UnauthorizedException();
    const authUser: AuthUser = {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role,
      ativo: user.ativo,
      tenantId: user.tenant_id,
      plSalesOnly: user.pl_sales_only,
    };
    await this.cache.set(cacheKey, authUser, USER_CACHE_TTL_SECONDS);
    return authUser;
  }
}
