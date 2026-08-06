import { Module } from '@nestjs/common';
import {
  ContactsController,
  CompaniesController,
  LeadContactsController,
} from './contacts.controller';
import { ContactsService } from './contacts.service';
import { CompaniesService } from './companies.service';
import { LeadsModule } from '../leads/leads.module';

/**
 * Contato e Empresa — entidades aditivas com campos personalizados próprios.
 *
 * Importa LeadsModule só para reusar `CustomFieldsService` (validação de
 * `dados_custom` nos escopos CONTATO/EMPRESA). Não há ciclo: LeadsModule não
 * conhece este módulo.
 */
@Module({
  imports: [LeadsModule],
  controllers: [ContactsController, CompaniesController, LeadContactsController],
  providers: [ContactsService, CompaniesService],
  exports: [ContactsService, CompaniesService],
})
export class ContactsModule {}
