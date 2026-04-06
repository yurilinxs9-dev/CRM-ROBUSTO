import { Controller, Get, Post, Patch, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { LeadsService } from './leads.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';

@Controller('leads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadsController {
  constructor(private leadsService: LeadsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>, @Query() filters: Record<string, string>) {
    return this.leadsService.findAll(req.user as Parameters<typeof this.leadsService.findAll>[0], filters);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.findOne(id, req.user as Parameters<typeof this.leadsService.findOne>[1]);
  }

  @Post()
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.create(body, req.user as Parameters<typeof this.leadsService.create>[1]);
  }

  @Patch(':id/stage')
  updateStage(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.updateStage(id, body, req.user as Parameters<typeof this.leadsService.updateStage>[2]);
  }

  @Get(':id/messages')
  getMessages(
    @Param('id') id: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.leadsService.getMessages(id, cursor, limit ? parseInt(limit) : 50);
  }

  @Post(':id/sync-profile')
  syncProfile(@Param('id') id: string) {
    return this.leadsService.syncProfile(id);
  }

  @Patch(':id/mark-read')
  markAsRead(@Param('id') id: string) {
    return this.leadsService.markAsRead(id);
  }
}
