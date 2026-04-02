import { Module } from '@nestjs/common';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';

@Module({
  controllers: [QuickRepliesController],
  providers: [QuickRepliesService],
})
export class QuickRepliesModule {}
