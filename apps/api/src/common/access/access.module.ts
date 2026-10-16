import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { PlSalesPolicyService } from './pl-sales-policy.service';
import { PlSalesMetadataInterceptor } from './pl-sales-metadata.interceptor';

@Global()
@Module({
  imports: [PrismaModule],
  providers: [PlSalesPolicyService, { provide: APP_INTERCEPTOR, useClass: PlSalesMetadataInterceptor }],
  exports: [PlSalesPolicyService],
})
export class AccessModule {}
