import { Module, Global } from '@nestjs/common';
import { MediaService } from './media.service';
import { AudioService } from './audio.service';
import { MediaPipelineService } from './media-pipeline.service';

@Global()
@Module({
  providers: [MediaService, AudioService, MediaPipelineService],
  exports: [MediaService, AudioService, MediaPipelineService],
})
export class MediaModule {}
