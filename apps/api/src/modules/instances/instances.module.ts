import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { InstanceHealthService } from './instance-health.service';
import { HistorySyncModule } from '../webhooks/history-sync.module';
import { PushModule } from '../push/push.module';

@Module({
  imports: [HttpModule, HistorySyncModule, PushModule],
  controllers: [InstancesController],
  providers: [InstancesService, InstanceHealthService],
  exports: [InstancesService, InstanceHealthService],
})
export class InstancesModule {}
