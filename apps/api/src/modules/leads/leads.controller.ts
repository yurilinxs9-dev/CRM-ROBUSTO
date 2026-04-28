import { Controller, Get, Post, Patch, Delete, Body, Param, Query, Req, Res, UseGuards } from '@nestjs/common';
import { LeadsService, type ExportLeadFilters } from './leads.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import type { Response } from 'express';

@Controller('leads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadsController {
  constructor(private leadsService: LeadsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>, @Query() filters: Record<string, string>) {
    return this.leadsService.findAll(req.user as AuthUser, filters);
  }

  @Post('bulk/move-stage')
  @Roles(UserRole.OPERADOR)
  bulkMoveStage(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.bulkMoveStage(body, req.user as AuthUser);
  }

  @Post('bulk/assign')
  @Roles(UserRole.OPERADOR)
  bulkAssign(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.bulkAssign(body, req.user as AuthUser);
  }

  @Post('bulk/tag')
  @Roles(UserRole.OPERADOR)
  bulkTag(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.bulkTag(body, req.user as AuthUser);
  }

  @Post('bulk/archive')
  @Roles(UserRole.OPERADOR)
  bulkArchive(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.bulkArchive(body, req.user as AuthUser);
  }

  @Get('export')
  exportCsv(
    @Req() req: Record<string, unknown>,
    @Res() res: Response,
    @Query() filters: ExportLeadFilters,
  ) {
    return this.leadsService.exportCsv(req.user as AuthUser, filters, res);
  }

  @Get(':id')
  findOne(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.findOne(id, req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.OPERADOR)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.create(body, req.user as AuthUser);
  }

  @Patch(':id')
  @Roles(UserRole.OPERADOR)
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.update(id, body, req.user as AuthUser);
  }

  @Patch(':id/stage')
  @Roles(UserRole.OPERADOR)
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

  @Get(':id/activities')
  getActivities(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.getActivities(id, req.user as AuthUser);
  }

  @Post(':id/sync-profile')
  @Roles(UserRole.OPERADOR)
  syncProfile(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.syncProfile(id, req.user as AuthUser);
  }

  /**
   * One-shot data repair: re-fetches name + photo from UazAPI for every lead
   * in the current tenant and force-overwrites local fields. Used after
   * shipping the pushName corruption fix to clean up legacy bad data.
   */
  @Post('sync-profiles')
  @Roles(UserRole.OPERADOR)
  syncAllProfiles(@Req() req: Record<string, unknown>) {
    return this.leadsService.syncAllProfilesForTenant(req.user as AuthUser);
  }

  @Post(':id/claim')
  @Roles(UserRole.OPERADOR)
  claim(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.claim(id, req.user as AuthUser);
  }

  @Post(':id/reassign')
  @Roles(UserRole.OPERADOR)
  reassign(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.leadsService.reassign(id, body, req.user as AuthUser);
  }

  @Post(':id/return-to-pool')
  @Roles(UserRole.OPERADOR)
  returnToPool(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.returnToPool(id, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles(UserRole.OPERADOR)
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.remove(id, req.user as AuthUser);
  }

  @Patch(':id/mark-read')
  markAsRead(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.leadsService.markAsRead(id, req.user as AuthUser);
  }
}
