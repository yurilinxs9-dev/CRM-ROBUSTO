import { Module, Global } from '@nestjs/common';
import { MediaService } from './media.service';
import { AudioService } from './audio.service';
import { MediaPipelineService } from './media-pipeline.service';
import { MediaCleanupService } from './media-cleanup.service';

@Global()
@Module({
  providers: [MediaService, AudioService, MediaPipelineService, MediaCleanupService],
  exports: [MediaService, AudioService, MediaPipelineService],
})
export class MediaModule {}
