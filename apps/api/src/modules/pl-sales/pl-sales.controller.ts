import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/types/auth-user';
import { PlSalesService } from './pl-sales.service';
@Controller('pl-sales')
@UseGuards(JwtAuthGuard)
export class PlSalesController {
 constructor(private readonly service:PlSalesService) {}
 @Get() dashboard(@Req() r:{user:AuthUser},@Query('month') month?:string,@Query('page') page?:string){return this.service.dashboard(r.user,month,page??1);}
 @Get('candidates') candidates(@Req() r:{user:AuthUser},@Query('search') s?:string){return this.service.candidates(r.user,s);}
 @Get('audit') audit(@Req() r:{user:AuthUser}){return this.service.history(r.user);}
 @Post() create(@Req() r:{user:AuthUser},@Body() b:unknown){return this.service.create(r.user,b);}
 @Patch(':id') update(@Req() r:{user:AuthUser},@Param('id') id:string,@Body() b:unknown){return this.service.update(r.user,id,b);}
 @Post(':id/cancel') cancel(@Req() r:{user:AuthUser},@Param('id') id:string,@Body() b:unknown){return this.service.cancel(r.user,id,b);}
 @Put('goals/:month/:owner') goal(@Req() r:{user:AuthUser},@Param('month') m:string,@Param('owner') o:string,@Body() b:unknown){return this.service.goal(r.user,m,o,b);}
}
