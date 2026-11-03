import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { AttributionModule } from '../attribution/attribution.module';
import { SheetImportService } from './sheet-import.service';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomFieldsService } from '../leads/custom-fields.service';
import { AttributionService } from '../attribution/attribution.service';
import { CrmGateway } from '../websocket/websocket.gateway';
import { LeadInsightsService } from '../lead-insights/lead-insights.service';
import { CONSORTIUM_SOURCE } from './sheet-import.source';

/**
 * Importação da planilha Meta Lead Ads (um tenant, por env). PrismaService,
 * CrmGateway e LeadInsightsService vêm de módulos @Global; ConfigModule é
 * global no AppModule.
 */
@Module({
  imports: [LeadsModule, AttributionModule],
  providers: [SheetImportService, {
    provide: 'PL_SHEET_IMPORT',
    inject: [PrismaService, ConfigService, CustomFieldsService, AttributionService, CrmGateway, LeadInsightsService],
    useFactory: (prisma: PrismaService, config: ConfigService, fields: CustomFieldsService,
      attribution: AttributionService, gateway: CrmGateway, insights: LeadInsightsService) =>
      new SheetImportService(prisma, config, fields, attribution, gateway, insights, CONSORTIUM_SOURCE),
  }],
})
export class SheetImportModule {}
