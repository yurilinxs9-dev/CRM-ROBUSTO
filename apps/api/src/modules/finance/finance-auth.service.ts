import { Injectable, UnauthorizedException, ConflictException, HttpException, HttpStatus } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AuthUser } from '../../common/types/auth-user';
import { createHash, randomBytes } from 'crypto';
import * as bcrypt from 'bcryptjs';
import { authorizeFinance, parseFinance } from './finance.domain';
import { loginSchema, setupSchema } from './finance.schemas';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
@Injectable()
export class FinanceAuthService {
    constructor(private readonly prisma: PrismaService) { }
    async status(user: AuthUser, token?: string) { authorizeFinance(user); const access = await this.prisma.financeAccess.findUnique({ where: { tenant_id: user.tenantId } }); let unlocked = false; let expires_at: string | null = null; if (token) {
        try {
            const s = await this.validate(user, token);
            unlocked = true;
            expires_at = s.expires_at.toISOString();
        }
        catch (e) {
            if (!(e instanceof UnauthorizedException))
                throw e;
        }
    } return { configured: !!access, unlocked, expires_at }; }
    private async locked(tenantId: string) { const access = await this.prisma.financeAccess.findUnique({ where: { tenant_id: tenantId } }); if (access?.locked_until && access.locked_until > new Date())
        throw new HttpException('Muitas tentativas. Aguarde 15 minutos.', HttpStatus.TOO_MANY_REQUESTS); return access; }
    private async failed(tenantId: string) { await this.prisma.financeAccess.updateMany({ where: { tenant_id: tenantId }, data: { failed_attempts: { increment: 1 } } }); await this.prisma.financeAccess.updateMany({ where: { tenant_id: tenantId, failed_attempts: { gte: 5 } }, data: { locked_until: new Date(Date.now() + 15 * 60000) } }); throw new UnauthorizedException({ message: 'Senha incorreta.', code: 'FINANCE_AUTH' }); }
    async setup(user: AuthUser, input: unknown) {
        authorizeFinance(user);
        const data = parseFinance(setupSchema, input);
        const access = await this.locked(user.tenantId);
        const account = await this.prisma.user.findFirst({ where: { id: user.id, tenant_id: user.tenantId, ativo: true }, select: { senha_hash: true } });
        if (!account || !await bcrypt.compare(data.currentPassword, account.senha_hash)) {
            if (access)
                return this.failed(user.tenantId);
            throw new UnauthorizedException({ message: 'Senha atual do CRM incorreta.', code: 'FINANCE_AUTH' });
        }
        const password_hash = await bcrypt.hash(data.newPassword, 12);
        await this.prisma.$transaction(async (tx) => {
            if (access) {
                const r = await tx.financeAccess.updateMany({ where: { tenant_id: user.tenantId, user_id: user.id, version: access.version }, data: { password_hash, version: { increment: 1 }, failed_attempts: 0, locked_until: null } });
                if (r.count !== 1)
                    throw new ConflictException('A credencial foi alterada. Atualize a página.');
            }
            else
                await tx.financeAccess.create({ data: { tenant_id: user.tenantId, user_id: user.id, password_hash } });
            await tx.financeSession.updateMany({ where: { tenant_id: user.tenantId, user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } });
            await tx.financeAudit.create({ data: { tenant_id: user.tenantId, user_id: user.id, action: access ? 'access.reset' : 'access.created', entity_id: user.id, after: { configured: true } } });
        });
        return { configured: true };
    }
    async login(user: AuthUser, input: unknown) {
        authorizeFinance(user);
        const { password } = parseFinance(loginSchema, input);
        const access = await this.locked(user.tenantId);
        if (!access || access.user_id !== user.id)
            throw new UnauthorizedException({ message: 'Configure a senha financeira primeiro.', code: 'FINANCE_AUTH' });
        if (!await bcrypt.compare(password, access.password_hash))
            return this.failed(user.tenantId);
        const token = randomBytes(32).toString('hex');
        const expires_at = new Date(Date.now() + 2 * 60 * 60000);
        await this.prisma.$transaction(async (tx) => { await tx.financeAccess.update({ where: { tenant_id: user.tenantId }, data: { failed_attempts: 0, locked_until: null } }); await tx.financeSession.create({ data: { token_hash: digest(token), tenant_id: user.tenantId, user_id: user.id, access_version: access.version, expires_at } }); await tx.financeAudit.create({ data: { tenant_id: user.tenantId, user_id: user.id, action: 'access.login', entity_id: user.id, after: { expires_at: expires_at.toISOString() } } }); });
        return { token, expires_at: expires_at.toISOString() };
    }
    async validate(user: AuthUser, token?: string) { authorizeFinance(user); if (!token || !/^[a-f0-9]{64}$/.test(token))
        throw new UnauthorizedException({ message: 'Desbloqueie o financeiro com sua senha exclusiva.', code: 'FINANCE_LOCKED' }); const s = await this.prisma.financeSession.findUnique({ where: { token_hash: digest(token) } }); const access = await this.prisma.financeAccess.findUnique({ where: { tenant_id: user.tenantId } }); if (!s || s.revoked_at || s.expires_at <= new Date() || s.tenant_id !== user.tenantId || s.user_id !== user.id || !access || access.user_id !== user.id || s.access_version !== access.version)
        throw new UnauthorizedException({ message: 'Sessão financeira expirada. Entre novamente.', code: 'FINANCE_LOCKED' }); return s; }
    async logout(user: AuthUser, token?: string) { authorizeFinance(user); if (token)
        await this.prisma.financeSession.updateMany({ where: { token_hash: digest(token), tenant_id: user.tenantId, user_id: user.id, revoked_at: null }, data: { revoked_at: new Date() } }); return { locked: true }; }
}
