import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
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

  @Post('send-audio')
  @UseInterceptors(FileInterceptor('file'))
  sendAudio(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    const user = req.user as { id: string };
    return this.messagesService.sendAudio(file, body, user.id);
  }

  @Post('send-media')
  @UseInterceptors(FileInterceptor('file'))
  sendMedia(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    const user = req.user as { id: string };
    return this.messagesService.sendMedia(file, body, user.id);
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
