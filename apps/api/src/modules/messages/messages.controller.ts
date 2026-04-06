import {
  Controller,
  Post,
  Get,
  Body,
  Param,
  Query,
  Req,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
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

  @Get(':id/media')
  async getMedia(@Param('id') id: string, @Res() res: Response) {
    const { stream, contentType, contentLength } =
      await this.messagesService.streamMedia(id);
    res.setHeader('Content-Type', contentType);
    if (contentLength) res.setHeader('Content-Length', String(contentLength));
    res.setHeader('Cache-Control', 'private, max-age=3600');
    stream.pipe(res);
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
