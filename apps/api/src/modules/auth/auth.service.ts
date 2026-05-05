import { Injectable, UnauthorizedException, ConflictException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

@Injectable()
export class AuthService {
  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
  ) {}

  async login(email: string, senha: string, remember = false) {
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user || !user.ativo) throw new UnauthorizedException('Credenciais invalidas');

    const valid = await bcrypt.compare(senha, user.senha_hash);
    if (!valid) throw new UnauthorizedException('Credenciais invalidas');

    return this.generateTokens(user, remember);
  }

  async generateTokens(
    user: { id: string; email: string; role: string; tenant_id: string },
    remember = false,
  ) {
    const payload = {
      sub: user.id,
      email: user.email,
      role: user.role,
      tenantId: user.tenant_id,
      remember,
    };

    const accessToken = this.jwtService.sign(payload);
    const refreshExpiry = remember
      ? this.config.get('JWT_REFRESH_EXPIRY_REMEMBER', '365d')
      : this.config.get('JWT_REFRESH_EXPIRY', '7d');
    const refreshToken = this.jwtService.sign(payload, {
      secret: this.config.get('JWT_REFRESH_SECRET'),
      expiresIn: refreshExpiry,
    });

    return { accessToken, refreshToken, remember };
  }

  async refreshToken(token: string) {
    try {
      const payload = this.jwtService.verify(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
      const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user || !user.ativo) throw new UnauthorizedException();
      return this.generateTokens(user, payload.remember === true);
    } catch {
      throw new UnauthorizedException('Refresh token invalido');
    }
  }

  async getMe(userId: string, tenantId: string) {
    const [user, tenant] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, nome: true, email: true, role: true, ativo: true, avatar_url: true, titulo: true, especialidade: true },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, nome: true, pool_enabled: true, prefix_enabled: true },
      }),
    ]);
    if (!user) throw new UnauthorizedException();
    return { user, tenant };
  }

  async createUser(data: {
    nome: string;
    email: string;
    senha: string;
    workspace_name?: string;
    account_model?: 'shared' | 'individual';
  }) {
    const exists = await this.prisma.user.findUnique({ where: { email: data.email } });
    if (exists) throw new ConflictException('Email ja cadastrado');

    const senha_hash = await bcrypt.hash(data.senha, 12);
    const userId = randomUUID();
    const tenantId = randomUUID();
    // Public signup creates a brand-new tenant; the signing-up user is the
    // owner of that workspace — never a platform-level role.
    const role = 'SUPER_ADMIN' as const;
    const workspaceName = data.workspace_name ?? `${data.nome}'s workspace`;

    return this.prisma.$transaction(async (tx) => {
      // FK User.tenant_id is DEFERRABLE INITIALLY DEFERRED so we can insert
      // user first referencing a tenant that will exist by commit time.
      await tx.$executeRaw`
        INSERT INTO "User" (id, nome, email, senha_hash, role, ativo, tenant_id, created_at, updated_at)
        VALUES (${userId}, ${data.nome}, ${data.email}, ${senha_hash}, ${role}::"UserRole", true, ${tenantId}, NOW(), NOW())
      `;
      await tx.tenant.create({
        data: {
          id: tenantId,
          nome: workspaceName,
          owner_id: userId,
          // Modelo de atendimento escolhido no register: 'shared' liga o pool
          // (1 número, vários operadores); 'individual' deixa cada operador
          // com sua própria instância. Default fica 'shared' pra preservar
          // comportamento histórico se o frontend não enviar o campo.
          pool_enabled: data.account_model === 'individual' ? false : true,
        },
      });

      // Default Pipeline + Stages for the new tenant
      await tx.pipeline.create({
        data: {
          nome: 'Padrao',
          tenant_id: tenantId,
          stages: {
            create: [
              { nome: 'Novo',        cor: '#38bdf8', ordem: 0, tenant_id: tenantId },
              { nome: 'Em contato',  cor: '#fb923c', ordem: 1, tenant_id: tenantId },
              { nome: 'Qualificado', cor: '#f97316', ordem: 2, tenant_id: tenantId },
              { nome: 'Ganho',       cor: '#22c55e', ordem: 3, tenant_id: tenantId, is_won: true },
              { nome: 'Perdido',     cor: '#ef4444', ordem: 4, tenant_id: tenantId, is_lost: true },
            ],
          },
        },
      });

      const created = await tx.user.findUniqueOrThrow({
        where: { id: userId },
        select: { id: true, nome: true, email: true, role: true, tenant_id: true, created_at: true },
      });
      return created;
    });
  }
}
