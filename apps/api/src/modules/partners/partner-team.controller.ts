import { Body, Controller, Get, Param, Patch, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AuthUser } from '../../common/types/auth-user';
import { PartnerTeamService } from './partner-team.service';

@Controller('partners/team')
@UseGuards(JwtAuthGuard)
export class PartnerTeamController {
  constructor(private readonly service: PartnerTeamService) {}
  @Get() dashboard(@Req() r: { user: AuthUser }, @Query() query: unknown) { return this.service.dashboard(r.user, query); }
  @Get('subjects') subjects(@Req() r: { user: AuthUser }, @Query('search') search?: string) { return this.service.subjects(r.user, search); }
  @Post('activities') create(@Req() r: { user: AuthUser }, @Body() body: unknown) { return this.service.create(r.user, body); }
  @Patch('activities/:id') update(@Req() r: { user: AuthUser }, @Param('id') id: string, @Body() body: unknown) { return this.service.update(r.user, id, body); }
  @Put('activities/:id/cancellation') cancel(@Req() r: { user: AuthUser }, @Param('id') id: string, @Body() body: unknown) { return this.service.cancel(r.user, id, body); }
  @Put('goals/:consultant/:month') goal(@Req() r: { user: AuthUser }, @Param('consultant') consultant: string, @Param('month') month: string, @Body() body: unknown) { return this.service.goal(r.user, consultant, month, body); }
}
