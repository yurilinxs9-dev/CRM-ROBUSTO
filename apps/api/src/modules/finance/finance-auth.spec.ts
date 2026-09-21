import { UnauthorizedException, ForbiddenException, ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FinanceAuthService } from './finance-auth.service';
import { FinanceGuard } from './finance.guard';
import { FINANCE_TENANT, FINANCE_USER } from './finance.domain';
import { AuthUser } from '../../common/types/auth-user';
const user: AuthUser = { id: FINANCE_USER, tenantId: FINANCE_TENANT, nome: 'Paloma', email: 'p@example.test', role: 'GERENTE', ativo: true };
const token = 'a'.repeat(64);
function fixture() { const db = { financeSession: { findUnique: jest.fn().mockResolvedValue({ tenant_id: FINANCE_TENANT, user_id: FINANCE_USER, access_version: 1, expires_at: new Date(Date.now() + 60000), revoked_at: null }), updateMany: jest.fn() }, financeAccess: { findUnique: jest.fn().mockResolvedValue({ tenant_id: FINANCE_TENANT, user_id: FINANCE_USER, version: 1 }) }, user: { findFirst: jest.fn().mockResolvedValue({ id: FINANCE_USER }) } }; const auth = new FinanceAuthService(db as unknown as PrismaService); return { db, auth }; }
describe('finance isolation and independent sessions', () => {
    it('requires finance token even with a valid CRM user', async () => { const f = fixture(); await expect(f.auth.validate(user)).rejects.toBeInstanceOf(UnauthorizedException); expect(f.db.financeSession.findUnique).not.toHaveBeenCalled(); });
    it('accepts only a live token bound to user, tenant and current credential', async () => { const f = fixture(); await expect(f.auth.validate(user, token)).resolves.toHaveProperty('access_version', 1); for (const patch of [{ user_id: 'other' }, { tenant_id: 'other' }, { revoked_at: new Date() }, { expires_at: new Date(0) }, { access_version: 2 }]) {
        f.db.financeSession.findUnique.mockResolvedValueOnce({ tenant_id: FINANCE_TENANT, user_id: FINANCE_USER, access_version: 1, expires_at: new Date(Date.now() + 60000), revoked_at: null, ...patch });
        await expect(f.auth.validate(user, token)).rejects.toBeInstanceOf(UnauthorizedException);
    } });
    it('blocks another admin with a stolen financial token', async () => { const f = fixture(); await expect(f.auth.validate({ ...user, id: 'another', role: 'SUPER_ADMIN' }, token)).rejects.toBeInstanceOf(ForbiddenException); expect(f.db.financeSession.findUnique).not.toHaveBeenCalled(); });
    it('does not let another user configure or reset financial credentials', async () => { const f = fixture(); await expect(f.auth.setup({ ...user, id: 'other' }, {})).rejects.toBeInstanceOf(ForbiddenException); });
    it('checks current active user and blocks impersonation in the guard', async () => { const f = fixture(); const reflector = { get: jest.fn().mockReturnValue(true) }; const guard = new FinanceGuard(f.auth, f.db as unknown as PrismaService, reflector as unknown as Reflector); const req = { user, get: jest.fn().mockReturnValue('Bearer h.' + Buffer.from(JSON.stringify({ sub: FINANCE_USER, impersonatedBy: 'admin' })).toString('base64url') + '.s') }; const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: jest.fn() }) }), getHandler: () => ({}) } as unknown as ExecutionContext; await expect(guard.canActivate(context)).rejects.toBeInstanceOf(ForbiddenException); req.get.mockReturnValue(undefined); f.db.user.findFirst.mockResolvedValueOnce(null); await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException); });
    it('checks financial session for protected routes, including configuration', async () => { const f = fixture(); const reflector = { get: jest.fn().mockReturnValue(false) }; const guard = new FinanceGuard(f.auth, f.db as unknown as PrismaService, reflector as unknown as Reflector); const req = { user, get: () => undefined }; const context = { switchToHttp: () => ({ getRequest: () => req, getResponse: () => ({ setHeader: jest.fn() }) }), getHandler: () => ({}) } as unknown as ExecutionContext; await expect(guard.canActivate(context)).rejects.toBeInstanceOf(UnauthorizedException); });
});
