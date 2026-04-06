import { Module } from '@nestjs/common';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';
import { TasksCron } from './tasks.cron';

@Module({
  controllers: [TasksController],
  providers: [TasksService, TasksCron],
  exports: [TasksService],
})
export class TasksModule {}
