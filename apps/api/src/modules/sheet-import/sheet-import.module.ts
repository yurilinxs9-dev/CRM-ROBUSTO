import { Module } from '@nestjs/common';
import { LeadsModule } from '../leads/leads.module';
import { AttributionModule } from '../attribution/attribution.module';
import { SheetImportService } from './sheet-import.service';

/**
 * Importação da planilha Meta Lead Ads (um tenant, por env). PrismaService,
 * CrmGateway e LeadInsightsService vêm de módulos @Global; ConfigModule é
 * global no AppModule.
 */
@Module({
  imports: [LeadsModule, AttributionModule],
  providers: [SheetImportService],
})
export class SheetImportModule {}
