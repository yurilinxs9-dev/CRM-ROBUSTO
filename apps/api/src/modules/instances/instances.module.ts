import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { InstancesController } from './instances.controller';
import { InstancesService } from './instances.service';
import { HistorySyncModule } from '../webhooks/history-sync.module';

@Module({
  imports: [HttpModule, HistorySyncModule],
  controllers: [InstancesController],
  providers: [InstancesService],
  exports: [InstancesService],
})
export class InstancesModule {}
