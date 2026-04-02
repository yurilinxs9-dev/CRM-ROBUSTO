import { Controller, Post, Get, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { MessagesService } from './messages.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('messages')
@UseGuards(JwtAuthGuard)
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post('send-text')
  sendText(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    const user = req.user as { id: string };
    return this.messagesService.sendText(body, user.id);
  }

  @Post('internal-note')
  createInternalNote(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    const user = req.user as { id: string };
    return this.messagesService.createInternalNote(body, user.id);
  }

  @Get('history/:leadId')
  getHistory(
    @Param('leadId') leadId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messagesService.getHistory(leadId, cursor, limit ? parseInt(limit) : 50);
  }
}
