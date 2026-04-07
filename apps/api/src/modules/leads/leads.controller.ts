import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('leads')
@UseGuards(JwtAuthGuard)
export class LeadsController {
  constructor(private leadsService: LeadsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>, @Query() filters: Record<string, string>) {
    return this.leadsService.findAll(req.user as AuthUser, filters);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.findOne(id, req.user as AuthUser);
  }

  @Post()
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.create(body, req.user as AuthUser);
  }

  @Patch(':id/stage')
  updateStage(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.updateStage(id, body, req.user as AuthUser);
  }

  @Get(':id/messages')
  getMessages(
    @Param('id') id: string,
    @Req() req: Record<string, unknown>,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.leadsService.getMessages(id, req.user as AuthUser, cursor, limit ? parseInt(limit) : 50);
  }

  @Post(':id/sync-profile')
  syncProfile(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.syncProfile(id, req.user as AuthUser);
  }

  @Delete(':id')
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.remove(id, req.user as AuthUser);
  }

  @Patch(':id/mark-read')
  markAsRead(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.markAsRead(id, req.user as AuthUser);
  }
}
