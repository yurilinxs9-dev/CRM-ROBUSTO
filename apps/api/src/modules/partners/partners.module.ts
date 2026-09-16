import { Module } from '@nestjs/common';
import { WebSocketModule } from '../websocket/websocket.module';
import { PartnersController } from './partners.controller';
import { PartnersService } from './partners.service';
@Module({imports:[WebSocketModule],controllers:[PartnersController],providers:[PartnersService]})
export class PartnersModule {}
