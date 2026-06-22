import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('platform-admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformAdminController {
  constructor(private readonly svc: PlatformAdminService) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Get('stats')
  stats() {
    return this.svc.stats();
  }

  @Get('tenants')
  tenants() {
    return this.svc.listTenants();
  }

  @Get('tenants/:id')
  tenant(@Param('id') id: string) {
    return this.svc.getTenant(id);
  }

  @Get('logs')
  logs() {
    return this.svc.logs();
  }

  @Get('health')
  health() {
    return this.svc.health();
  }

  @Patch('users/:id/ban')
  banUser(@Param('id') id: string, @Body() body: { banned: boolean }, @Req() req: Request) {
    return this.svc.setUserBanned(this.user(req), id, !!body?.banned);
  }

  @Delete('users/:id')
  deleteUser(@Param('id') id: string, @Req() req: Request) {
    return this.svc.deleteUser(this.user(req), id);
  }

  @Delete('tenants/:id')
  deleteTenant(@Param('id') id: string, @Req() req: Request) {
    return this.svc.deleteTenant(this.user(req), id);
  }

  @Patch('tenants/:id/suspend')
  suspendTenant(@Param('id') id: string, @Body() body: { suspended: boolean }, @Req() req: Request) {
    return this.svc.setTenantSuspended(this.user(req), id, !!body?.suspended);
  }

  @Post('impersonate/:userId')
  impersonate(@Param('userId') userId: string, @Req() req: Request) {
    return this.svc.impersonate(this.user(req), userId, req.ip);
  }

  @Get('announcements')
  listAnnouncements() {
    return this.svc.listAnnouncements();
  }

  @Post('announcements')
  createAnnouncement(@Body() body: unknown, @Req() req: Request) {
    return this.svc.createAnnouncement(this.user(req), body);
  }

  @Patch('announcements/:id')
  setActive(@Param('id') id: string, @Body() body: { active: boolean }) {
    return this.svc.setAnnouncementActive(id, !!body?.active);
  }
}
