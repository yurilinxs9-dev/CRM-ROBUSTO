import { PlSalesController } from '../pl-sales/pl-sales.controller';
import { PlSalesService } from '../pl-sales/pl-sales.service';
import { Module } from '@nestjs/common';
import { WebSocketModule } from '../websocket/websocket.module';
import { PartnersController } from './partners.controller';
import { PartnerTeamController } from './partner-team.controller';
import { PartnerTeamService } from './partner-team.service';
import { PartnersService } from './partners.service';
@Module({imports:[WebSocketModule],controllers:[PlSalesController,PartnerTeamController,PartnersController],providers:[PlSalesService,PartnersService,PartnerTeamService]})
export class PartnersModule {}
