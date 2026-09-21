import { Body, Controller, Get, Param, Patch, Post, Query, Req, SetMetadata, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { FinanceGuard, FinanceRequest } from './finance.guard';
import { FinanceAuthService } from './finance-auth.service';
import { FinanceService } from './finance.service';
@Controller('financeiro')
@UseGuards(JwtAuthGuard, FinanceGuard)
export class FinanceController {
    constructor(private readonly auth: FinanceAuthService, private readonly finance: FinanceService) { }
    @Get('access')
    @SetMetadata('finance:auth-route', true)
    access(
    @Req()
    r: FinanceRequest) { return r.user.financeActorId ? { platform_access: true, unlocked: true } : this.auth.status(r.user, r.get('x-finance-session')); }
    @Post('access/setup')
    @SetMetadata('finance:auth-route', true)
    @Throttle({ default: { limit: 5, ttl: 900000 } })
    setup(
    @Req()
    r: FinanceRequest,
    @Body()
    body: unknown) { return this.auth.setup(r.user, body); }
    @Post('access/login')
    @SetMetadata('finance:auth-route', true)
    @Throttle({ default: { limit: 10, ttl: 900000 } })
    login(
    @Req()
    r: FinanceRequest,
    @Body()
    body: unknown) { return this.auth.login(r.user, body); }
    @Post('access/logout')
    @SetMetadata('finance:auth-route', true)
    logout(
    @Req()
    r: FinanceRequest) { return this.auth.logout(r.user, r.get('x-finance-session')); }
    @Get('rule')
    rule(
    @Req()
    r: FinanceRequest) { return this.finance.rule(r.user); }
    @Post('rule')
    changeRule(
    @Req()
    r: FinanceRequest,
    @Body()
    body: unknown) { return this.finance.updateRule(r.user, body); }
    @Post('sync')
    sync(
    @Req()
    r: FinanceRequest) { return this.finance.sync(r.user); }
    @Get('dashboard')
    dashboard(
    @Req()
    r: FinanceRequest,
    @Query()
    query: unknown) { return this.finance.dashboard(r.user, query); }
    @Get('history')
    history(
    @Req()
    r: FinanceRequest,
    @Query()
    query: unknown) { return this.finance.history(r.user, query); }
    @Get('sales')
    sales(
    @Req()
    r: FinanceRequest) { return this.finance.sales(r.user); }
    @Post('sales')
    manual(
    @Req()
    r: FinanceRequest,
    @Body()
    body: unknown) { return this.finance.manual(r.user, body); }
    @Patch('sales/:id')
    updateManual(
    @Req()
    r: FinanceRequest,
    @Param('id')
    id: string,
    @Body()
    body: unknown) { return this.finance.updateManual(r.user, id, body); }
    @Post('sales/:id/reconcile')
    reconcile(
    @Req()
    r: FinanceRequest,
    @Param('id')
    id: string,
    @Body()
    body: unknown) { return this.finance.reconcile(r.user, id, body); }
    @Post('sales/:id/cancel')
    cancel(
    @Req()
    r: FinanceRequest,
    @Param('id')
    id: string,
    @Body()
    body: unknown) { return this.finance.cancel(r.user, id, body); }
    @Patch('installments/:id')
    installment(
    @Req()
    r: FinanceRequest,
    @Param('id')
    id: string,
    @Body()
    body: unknown) { return this.finance.updateInstallment(r.user, id, body); }
    @Get('audit')
    audit(
    @Req()
    r: FinanceRequest) { return this.finance.auditHistory(r.user); }
}
