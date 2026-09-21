import { Module } from '@nestjs/common';
import { FinanceController } from './finance.controller';
import { FinanceService } from './finance.service';
import { FinanceAuthService } from './finance-auth.service';
import { FinanceGuard } from './finance.guard';
@Module({ controllers: [FinanceController], providers: [FinanceService, FinanceAuthService, FinanceGuard] })
export class FinanceModule {
}
