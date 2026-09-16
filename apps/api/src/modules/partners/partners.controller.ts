import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/types/auth-user';
import { PartnersService } from './partners.service';
@Controller('partners')
@UseGuards(JwtAuthGuard)
export class PartnersController {
  constructor(private readonly service: PartnersService) {}
  @Get() dashboard(@Req() req: {user:AuthUser}, @Query('month') month?: string) { return this.service.dashboard(req.user,month); }
  @Get('candidates') candidates(@Req() req: {user:AuthUser}, @Query('search') search?: string) { return this.service.candidates(req.user,search); }
  @Get('audit') audit(@Req() req: {user:AuthUser}, @Query('partner_id') id?: string) { return this.service.history(req.user,id); }
  @Post() create(@Req() req: {user:AuthUser}, @Body() body: unknown) { return this.service.create(req.user,body); }
  @Patch(':id') update(@Req() req: {user:AuthUser}, @Param('id') id: string, @Body() body: unknown) { return this.service.update(req.user,id,body); }
  @Put('goals/:month') goal(@Req() req: {user:AuthUser}, @Param('month') month: string, @Body() body: unknown) { return this.service.goal(req.user,month,body); }
  @Put(':id/production/:date') production(@Req() req: {user:AuthUser}, @Param('id') id: string, @Param('date') date: string, @Body() body: unknown) { return this.service.production(req.user,id,date,body); }
}
