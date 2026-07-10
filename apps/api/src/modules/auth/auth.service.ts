import {
  Injectable,
  Logger,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  HttpException,
  HttpStatus,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { RedisCacheService } from '../../common/cache/redis-cache.service';
import * as bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID } from 'crypto';

/** Janela de contagem de falhas de login (s). */
const FAIL_WINDOW_SECONDS = 15 * 60;
/** Falhas dentro da janela antes de travar a conta. */
const LOCK_THRESHOLD = 5;
/** Teto do lock progressivo (s). */
const LOCK_MAX_SECONDS = 30 * 60;

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private prisma: PrismaService,
    private jwtService: JwtService,
    private config: ConfigService,
    private cache: RedisCacheService,
  ) {}

  private hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }

  async login(email: string, senha: string, remember = false, ip?: string, userAgent?: string) {
    // Lockout progressivo por conta: além do throttle por IP do endpoint,
    // trava a CONTA após LOCK_THRESHOLD falhas (2^n min, teto 30min) —
    // brute-force distribuído em IPs não escapa.
    const lockKey = `auth:lock:${email}`;
    const lockedUntil = await this.cache.get<number>(lockKey);
    if (lockedUntil && lockedUntil > Date.now()) {
      const seconds = Math.ceil((lockedUntil - Date.now()) / 1000);
      throw new HttpException(
        `Conta temporariamente bloqueada por excesso de tentativas. Tente em ${seconds}s.`,
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    const user = await this.prisma.user.findUnique({ where: { email } });
    const fail = async (reason: string): Promise<never> => {
      await this.registerLoginFailure(email);
      await this.logLogin(user?.id ?? null, email, false, ip, reason);
      throw new UnauthorizedException('Credenciais invalidas');
    };
    if (!user) return fail('user_not_found');
    if (!user.ativo) return fail('inactive');
    const valid = await bcrypt.compare(senha, user.senha_hash);
    if (!valid) return fail('bad_password');

    await this.cache.del(`auth:failcount:${email}`);
    await this.cache.del(lockKey);
    await this.logLogin(user.id, email, true, ip);
    return this.generateTokens(user, remember, { ip, userAgent });
  }

  private async registerLoginFailure(email: string) {
    try {
      const count = await this.cache.incr(`auth:failcount:${email}`, FAIL_WINDOW_SECONDS);
      if (count >= LOCK_THRESHOLD) {
        const lockSeconds = Math.min(
          60 * 2 ** (count - LOCK_THRESHOLD),
          LOCK_MAX_SECONDS,
        );
        await this.cache.set(`auth:lock:${email}`, Date.now() + lockSeconds * 1000, lockSeconds);
      }
    } catch {
      /* Redis fora não pode derrubar login — throttle por IP segue valendo */
    }
  }

  /** Registra tentativa de login (sucesso/falha + IP) pra auditoria no painel admin. */
  private async logLogin(userId: string | null, email: string, success: boolean, ip?: string, reason?: string) {
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          admin_user_id: userId ?? 'anonymous',
          action: success ? 'login_success' : 'login_failed',
          detail: { email, ...(reason ? { reason } : {}) },
          ip: ip ?? null,
        },
      });
    } catch { /* nunca quebrar o login por causa do log */ }
  }

  async generateTokens(
    user: { id: string; email: string; role: string; tenant_id: string },
    remember = false,
    opts: { familyId?: string; ip?: string; userAgent?: string } = {},
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

    // Persiste a sessão pra rotação/revogação. exp vem do próprio JWT
    // pra DB e token nunca divergirem.
    const decoded = this.jwtService.decode(refreshToken) as { exp?: number } | null;
    const expiresAt = decoded?.exp
      ? new Date(decoded.exp * 1000)
      : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const row = await this.prisma.refreshToken.create({
      data: {
        user_id: user.id,
        family_id: opts.familyId ?? randomUUID(),
        token_hash: this.hashToken(refreshToken),
        remember,
        expires_at: expiresAt,
        ip: opts.ip ?? null,
        user_agent: opts.userAgent ?? null,
      },
      select: { id: true },
    });

    return { accessToken, refreshToken, remember, tokenId: row.id };
  }

  async refreshToken(token: string, ip?: string, userAgent?: string) {
    let payload: { sub: string; remember?: unknown };
    try {
      payload = this.jwtService.verify(token, {
        secret: this.config.get('JWT_REFRESH_SECRET'),
      });
    } catch {
      throw new UnauthorizedException('Refresh token invalido');
    }

    const row = await this.prisma.refreshToken.findUnique({
      where: { token_hash: this.hashToken(token) },
    });

    // Reuse-detection: token já rotacionado/revogado voltou = cópia roubada
    // (ou race benigno raro). Revoga a família inteira — atacante E vítima
    // caem; a vítima re-loga, o atacante fica sem nada.
    if (row?.revoked_at) {
      await this.revokeFamily(row.family_id);
      this.logger.warn(
        `Reuso de refresh token revogado — família ${row.family_id} do user ${row.user_id} revogada (ip=${ip ?? '?'})`,
      );
      throw new UnauthorizedException('Sessao revogada');
    }
    if (row && row.expires_at < new Date()) {
      throw new UnauthorizedException('Refresh token expirado');
    }

    const user = await this.prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.ativo) throw new UnauthorizedException('Refresh token invalido');

    // row === null: token legado (emitido antes da rotação existir) com
    // assinatura válida — adota criando família nova em vez de deslogar todo
    // mundo no deploy. Caminho morre sozinho quando os legados expirarem.
    const tokens = await this.generateTokens(user, payload.remember === true, {
      familyId: row?.family_id,
      ip,
      userAgent,
    });
    if (row) {
      await this.prisma.refreshToken.update({
        where: { id: row.id },
        data: { revoked_at: new Date(), replaced_by: tokens.tokenId },
      });
    }
    return tokens;
  }

  /** Logout de verdade: revoga a família da sessão (não só limpa cookie). */
  async logout(token: string | undefined) {
    if (!token) return;
    const row = await this.prisma.refreshToken.findUnique({
      where: { token_hash: this.hashToken(token) },
      select: { family_id: true },
    });
    if (row) await this.revokeFamily(row.family_id);
  }

  private async revokeFamily(familyId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { family_id: familyId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /** Revoga todas as sessões do usuário (troca de senha, offboarding). */
  async revokeAllSessions(userId: string) {
    await this.prisma.refreshToken.updateMany({
      where: { user_id: userId, revoked_at: null },
      data: { revoked_at: new Date() },
    });
  }

  /**
   * Esqueci minha senha. SEMPRE responde igual (não vaza se o email existe).
   * Sem SMTP configurado, loga a URL no servidor — admin encaminha manualmente.
   */
  async forgotPassword(email: string) {
    const user = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, ativo: true },
    });
    if (user?.ativo) {
      const raw = randomBytes(32).toString('hex');
      await this.prisma.passwordResetToken.create({
        data: {
          user_id: user.id,
          token_hash: this.hashToken(raw),
          expires_at: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const frontend = (this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000')
        .split(',')[0]
        .trim();
      const resetUrl = `${frontend}/reset-password?token=${raw}`;
      // TODO(SMTP): enviar por e-mail quando houver provedor configurado.
      this.logger.warn(`[password-reset] URL de reset para ${email}: ${resetUrl}`);
    }
    return { message: 'Se o e-mail existir, um link de redefinicao foi enviado.' };
  }

  async resetPassword(rawToken: string, novaSenha: string) {
    const row = await this.prisma.passwordResetToken.findUnique({
      where: { token_hash: this.hashToken(rawToken) },
    });
    if (!row || row.used_at || row.expires_at < new Date()) {
      throw new BadRequestException('Token invalido ou expirado');
    }
    const senha_hash = await bcrypt.hash(novaSenha, 12);
    await this.prisma.$transaction([
      this.prisma.user.update({ where: { id: row.user_id }, data: { senha_hash } }),
      this.prisma.passwordResetToken.update({
        where: { id: row.id },
        data: { used_at: new Date() },
      }),
    ]);
    // Senha trocada = todas as sessões antigas morrem.
    await this.revokeAllSessions(row.user_id);
    return { message: 'Senha redefinida com sucesso' };
  }

  /** Limpeza diária: sessões expiradas/revogadas velhas e resets vencidos. */
  @Cron('0 4 * * *')
  async cleanupExpiredTokens() {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    try {
      const [rt, prt] = await this.prisma.$transaction([
        this.prisma.refreshToken.deleteMany({
          where: { OR: [{ expires_at: { lt: new Date() } }, { revoked_at: { lt: cutoff } }] },
        }),
        this.prisma.passwordResetToken.deleteMany({
          where: { expires_at: { lt: cutoff } },
        }),
      ]);
      if (rt.count || prt.count) {
        this.logger.log(`cleanup tokens: ${rt.count} refresh, ${prt.count} reset removidos`);
      }
    } catch (e) {
      this.logger.error(`cleanup tokens falhou: ${e}`);
    }
  }

  async getMe(userId: string, tenantId: string) {
    const [user, tenant] = await Promise.all([
      this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, nome: true, email: true, role: true, ativo: true, avatar_url: true, titulo: true, especialidade: true, is_platform_admin: true },
      }),
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, nome: true, pool_enabled: true, prefix_enabled: true, round_robin_enabled: true, share_history_enabled: true },
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
