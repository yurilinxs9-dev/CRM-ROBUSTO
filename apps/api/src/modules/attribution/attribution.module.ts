import { Module } from '@nestjs/common';
import { AttributionController } from './attribution.controller';
import { TrackController } from './track.controller';
import { AttributionService } from './attribution.service';

/**
 * Atribuição de origem do lead. PrismaService e RedisCacheService vêm de
 * módulos @Global. O service é exportado porque os dois pontos de entrada de
 * lead (inbound do WhatsApp e API pública) precisam gravar o first-touch.
 */
@Module({
  controllers: [AttributionController, TrackController],
  providers: [AttributionService],
  exports: [AttributionService],
})
export class AttributionModule {}
