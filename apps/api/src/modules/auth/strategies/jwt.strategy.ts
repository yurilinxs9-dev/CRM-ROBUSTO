import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { AuthUser } from '../../../common/types/auth-user';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService, private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      secretOrKey: config.get('JWT_SECRET'),
    });
  }

  async validate(payload: { sub: string; email: string; role: string; tenantId: string }): Promise<AuthUser> {
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: { id: true, nome: true, email: true, role: true, ativo: true, tenant_id: true },
    });
    if (!user || !user.ativo) throw new UnauthorizedException();
    return {
      id: user.id,
      nome: user.nome,
      email: user.email,
      role: user.role,
      ativo: user.ativo,
      tenantId: user.tenant_id,
    };
  }
}
