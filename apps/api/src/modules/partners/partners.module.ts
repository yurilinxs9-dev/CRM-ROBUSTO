import { Module } from '@nestjs/common';
import { WebSocketModule } from '../websocket/websocket.module';
import { PartnersController } from './partners.controller';
import { PartnerTeamController } from './partner-team.controller';
import { PartnerTeamService } from './partner-team.service';
import { PartnersService } from './partners.service';
@Module({imports:[WebSocketModule],controllers:[PartnerTeamController,PartnersController],providers:[PartnersService,PartnerTeamService]})
export class PartnersModule {}
