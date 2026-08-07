import { Module } from '@nestjs/common';
import { LeadViewsController } from './lead-views.controller';
import { LeadViewsService } from './lead-views.service';

@Module({
  controllers: [LeadViewsController],
  providers: [LeadViewsService],
})
export class LeadViewsModule {}
