import { Module, Global } from '@nestjs/common';
import { MediaService } from './media.service';
import { AudioService } from './audio.service';

@Global()
@Module({
  providers: [MediaService, AudioService],
  exports: [MediaService, AudioService],
})
export class MediaModule {}
