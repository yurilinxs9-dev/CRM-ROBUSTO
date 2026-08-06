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
import { z } from 'zod';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';
import { PlatformScopes } from './platform-scopes.decorator';

const bannedSchema = z.object({ banned: z.boolean() });
const suspendedSchema = z.object({ suspended: z.boolean() });
const activeSchema = z.object({ active: z.boolean() });

/**
 * TODA rota daqui declara seu escopo. O guard é fail-closed: rota nova sem
 * @PlatformScopes só é acessível ao admin master ('*'). O escopo abre a ÁREA;
 * quem protege o tenant do master dentro da área é o service
 * (`assertTenantAllowed`), porque o admin restrito tem as mesmas telas — só
 * não alcança aquele tenant nem os usuários dele.
 */
@Controller('platform-admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformAdminController {
  constructor(private readonly svc: PlatformAdminService) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Get('stats')
  @PlatformScopes('overview')
  stats() {
    return this.svc.stats();
  }

  @Get('tenants')
  @PlatformScopes('tenants')
  tenants(@Req() req: Request) {
    return this.svc.listTenants(this.user(req));
  }

  @Get('tenants/:id')
  @PlatformScopes('tenants')
  tenant(@Param('id') id: string, @Req() req: Request) {
    return this.svc.getTenant(this.user(req), id);
  }

  @Get('logs')
  @PlatformScopes('logs')
  logs() {
    return this.svc.logs();
  }

  @Get('health')
  @PlatformScopes('health')
  health() {
    return this.svc.health();
  }

  @Patch('users/:id/ban')
  @PlatformScopes('tenant_actions')
  banUser(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { banned } = bannedSchema.parse(body);
    return this.svc.setUserBanned(this.user(req), id, banned);
  }

  @Delete('users/:id')
  @PlatformScopes('tenant_actions')
  deleteUser(@Param('id') id: string, @Req() req: Request) {
    return this.svc.deleteUser(this.user(req), id);
  }

  @Delete('tenants/:id')
  @PlatformScopes('tenant_actions')
  deleteTenant(@Param('id') id: string, @Req() req: Request) {
    return this.svc.deleteTenant(this.user(req), id);
  }

  @Patch('tenants/:id/suspend')
  @PlatformScopes('tenant_actions')
  suspendTenant(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { suspended } = suspendedSchema.parse(body);
    return this.svc.setTenantSuspended(this.user(req), id, suspended);
  }

  @Post('impersonate/:userId')
  @PlatformScopes('tenant_actions')
  impersonate(@Param('userId') userId: string, @Req() req: Request) {
    return this.svc.impersonate(this.user(req), userId, req.ip);
  }

  @Get('announcements')
  @PlatformScopes('announcements')
  listAnnouncements(@Req() req: Request) {
    return this.svc.listAnnouncements(this.user(req));
  }

  @Post('announcements')
  @PlatformScopes('announcements')
  createAnnouncement(@Body() body: unknown, @Req() req: Request) {
    return this.svc.createAnnouncement(this.user(req), body);
  }

  @Patch('announcements/:id')
  @PlatformScopes('announcements')
  setActive(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { active } = activeSchema.parse(body);
    return this.svc.setAnnouncementActive(this.user(req), id, active);
  }
}
