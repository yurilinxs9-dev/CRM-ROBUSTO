import { Module, Global } from '@nestjs/common';
import { MediaService } from './media.service';
import { MediaController } from './media.controller';
import { AudioService } from './audio.service';
import { MediaPipelineService } from './media-pipeline.service';
import { MediaCleanupService } from './media-cleanup.service';

@Global()
@Module({
  controllers: [MediaController],
  providers: [MediaService, AudioService, MediaPipelineService, MediaCleanupService],
  exports: [MediaService, AudioService, MediaPipelineService],
})
export class MediaModule {}
