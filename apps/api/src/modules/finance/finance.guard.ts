import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../common/prisma/prisma.service';
import { authorizeFinance, FINANCE_PLATFORM_OWNER } from './finance.domain';
import { FinanceAuthService } from './finance-auth.service';
export type FinanceRequest = Request & {
    user: AuthUser;
};
@Injectable()
export class FinanceGuard implements CanActivate {
    constructor(private readonly auth: FinanceAuthService, private readonly prisma: PrismaService, private readonly reflector: Reflector) { }
    async canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<FinanceRequest>();
        const res = context.switchToHttp().getResponse<Response>();
        res.setHeader('Cache-Control', 'no-store, private');
        res.setHeader('Pragma', 'no-cache');
        authorizeFinance(req.user);
        // JwtAuthGuard verified the signature. Only the named platform owner may bypass the financial session.
        const encoded = req.get('authorization')?.split(' ')[1]?.split('.')[1];
        const claims = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown> : {};
        if (claims.impersonatedBy) {
            if (claims.impersonatedBy !== FINANCE_PLATFORM_OWNER)
                throw new ForbiddenException('Financeiro indisponível para este administrador.');
            const owner = await this.prisma.user.findFirst({ where: { id: FINANCE_PLATFORM_OWNER, ativo: true, is_platform_admin: true, platform_scopes: { has: '*' } }, select: { id: true } });
            if (!owner) throw new ForbiddenException('Acesso do administrador revogado.');
            if (req.method !== 'GET' && this.reflector.get<boolean>('finance:auth-route', context.getHandler()))
                throw new ForbiddenException('A senha financeira é gerenciada pela Paloma.');
            req.user = { ...req.user, financeActorId: owner.id };
        }
        const current = await this.prisma.user.findFirst({ where: { id: req.user.id, tenant_id: req.user.tenantId, ativo: true }, select: { id: true } });
        if (!current)
            throw new UnauthorizedException();
        if (!req.user.financeActorId && !this.reflector.get<boolean>('finance:auth-route', context.getHandler()))
            await this.auth.validate(req.user, req.get('x-finance-session'));
        return true;
    }
}
