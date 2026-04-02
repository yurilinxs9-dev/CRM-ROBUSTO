import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { MessagesController } from './messages.controller';
import { MessagesService } from './messages.service';
import { MediaModule } from '../media/media.module';

@Module({
  imports: [HttpModule, MediaModule],
  controllers: [MessagesController],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
