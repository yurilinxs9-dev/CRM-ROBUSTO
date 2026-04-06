import { Controller, Get, Patch, Param, Req, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private service: NotificationsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.service.findAll(req.user as AuthUser);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.service.markRead(id, req.user as AuthUser);
  }
}
