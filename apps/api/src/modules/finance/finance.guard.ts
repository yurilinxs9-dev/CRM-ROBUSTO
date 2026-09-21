import { CanActivate, ExecutionContext, Injectable, UnauthorizedException, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Request, Response } from 'express';
import { AuthUser } from '../../common/types/auth-user';
import { PrismaService } from '../../common/prisma/prisma.service';
import { authorizeFinance } from './finance.domain';
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
        // JwtAuthGuard already verified the signature; disallow admin impersonation.
        const encoded = req.get('authorization')?.split(' ')[1]?.split('.')[1];
        const claims = encoded ? JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as Record<string, unknown> : {};
        if (claims.impersonatedBy)
            throw new ForbiddenException('Financeiro não permite acesso por impersonação.');
        const current = await this.prisma.user.findFirst({ where: { id: req.user.id, tenant_id: req.user.tenantId, ativo: true }, select: { id: true } });
        if (!current)
            throw new UnauthorizedException();
        if (!this.reflector.get<boolean>('finance:auth-route', context.getHandler()))
            await this.auth.validate(req.user, req.get('x-finance-session'));
        return true;
    }
}
