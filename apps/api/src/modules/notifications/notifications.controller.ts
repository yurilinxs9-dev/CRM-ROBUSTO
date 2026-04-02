import { Controller, Get, Patch, Param, Req, UseGuards } from '@nestjs/common';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private service: NotificationsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    const user = req.user as { id: string };
    return this.service.findAll(user.id);
  }

  @Patch(':id/read')
  markRead(@Param('id') id: string) {
    return this.service.markRead(id);
  }
}
