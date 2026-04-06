import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { TasksService } from './tasks.service';

@Injectable()
export class TasksCron {
  private readonly logger = new Logger(TasksCron.name);
  constructor(private tasks: TasksService) {}

  @Cron('*/5 * * * *')
  async checkOverdue() {
    try {
      const { updated } = await this.tasks.markOverdueBatch();
      if (updated > 0) {
        this.logger.log(`Marcadas ${updated} tarefas como ATRASADA`);
      }
    } catch (err) {
      this.logger.warn(`markOverdueBatch erro: ${String(err)}`);
    }
  }
}
