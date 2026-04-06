import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async login(email: string, senha: string) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.ativo) throw new UnauthorizedException('Credenciais invalidas');

    const valid = await bcrypt.compare(senha, user.senha_hash);
    if (!valid) throw new UnauthorizedException('Credenciais invalidas');

    return this.generateTokens(user);
  }

  async generateTokens(user: { id: string; email: string; role: string }) {
    const payload = { sub: user.id, email: user.email, role: user.role };

    const accessToken = this.jwtService.sign(payload);
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: this.config.get('JWT_REFRESH_EXPIRY', '7d'),
    });

    return { accessToken, refreshToken };
  }

  async refreshToken(token: string) {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.ativo) throw new UnauthorizedException();
      return this.generateTokens(user);
    } catch {
      throw new UnauthorizedException('Refresh token invalido');
    }
  }

  async createUser(data: { nome: string; email: string; senha: string; role?: string }) {
    const exists = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw new ConflictException('Email ja cadastrado');

    const senha_hash = await bcrypt.hash(data.senha, 12);
    return this.prisma.user.create({
      data: {
        nome: data.nome,
        email: data.email,
        senha_hash,
        role: (data.role as 'SUPER_ADMIN' | 'GERENTE' | 'OPERADOR' | 'VISUALIZADOR') ?? 'OPERADOR',
      },
      select: { id: true, nome: true, email: true, role: true, created_at: true },
    });
  }
}
