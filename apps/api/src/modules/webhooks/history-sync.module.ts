import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { BullModule } from '@nestjs/bullmq';
import { HistorySyncService } from './history-sync.service';

/**
 * Módulo próprio (não dentro do WebhooksModule) pra ser importável por
 * InstancesModule e PlatformAdminModule sem ciclo: os endpoints manuais de
 * sync vivem lá, e o WebhooksModule só precisa do serviço pro gatilho de
 * reconexão do UazapiEventsHandler.
 */
@Module({
  imports: [HttpModule, BullModule.registerQueue({ name: 'webhooks' })],
  providers: [HistorySyncService],
  exports: [HistorySyncService],
})
export class HistorySyncModule {}
