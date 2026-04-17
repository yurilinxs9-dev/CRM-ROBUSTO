import { Module } from '@nestjs/common';
import { AutomationService } from './automation.service';
import { LeadsModule } from '../leads/leads.module';
import { MessagesModule } from '../messages/messages.module';

@Module({
  imports: [LeadsModule, MessagesModule],
  providers: [AutomationService],
  exports: [AutomationService],
})
export class AutomationModule {}
