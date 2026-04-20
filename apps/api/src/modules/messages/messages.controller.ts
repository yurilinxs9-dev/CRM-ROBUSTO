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
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('messages')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MessagesController {
  constructor(private messagesService: MessagesService) {}

  @Post('send-text')
  @Roles(UserRole.OPERADOR)
  sendText(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.messagesService.sendText(body, req.user as AuthUser);
  }

  @Post('send-audio')
  @Roles(UserRole.OPERADOR)
  @UseInterceptors(FileInterceptor('file'))
  sendAudio(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    return this.messagesService.sendAudio(file, body, req.user as AuthUser);
  }

  @Post('send-media')
  @Roles(UserRole.OPERADOR)
  @UseInterceptors(FileInterceptor('file'))
  sendMedia(
    @UploadedFile() file: Express.Multer.File,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    return this.messagesService.sendMedia(file, body, req.user as AuthUser);
  }

  @Post('internal-note')
  @Roles(UserRole.OPERADOR)
  createInternalNote(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.messagesService.createInternalNote(body, req.user as AuthUser);
  }

  @Get(':id/media')
  async getMedia(@Param('id') id: string, @Req() req: Record<string, unknown>, @Res() res: Response) {
    try {
      const { stream, contentType, contentLength } =
        await this.messagesService.streamMedia(id, req.user as AuthUser);
      res.setHeader('Content-Type', contentType);
      if (contentLength) res.setHeader('Content-Length', String(contentLength));
      res.setHeader('Cache-Control', 'private, max-age=3600');
      stream.pipe(res);
    } catch (err) {
      const status = (err as Record<string, unknown>)?.status ?? 500;
      const message = (err as Record<string, unknown>)?.message ?? 'Erro interno';
      if (!res.headersSent) {
        res.status(typeof status === 'number' ? status : 500).json({ message });
      }
    }
  }

  @Get('history/:leadId')
  getHistory(
    @Param('leadId') leadId: string,
    @Req() req: Record<string, unknown>,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.messagesService.getHistory(leadId, req.user as AuthUser, cursor, limit ? parseInt(limit) : 50);
  }
}
