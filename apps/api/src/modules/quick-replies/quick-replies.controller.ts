import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { QuickRepliesService } from './quick-replies.service';

interface CreateQuickReplyBody { titulo: string; conteudo: string; is_global?: boolean; }
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('quick-replies')
@UseGuards(JwtAuthGuard)
export class QuickRepliesController {
  constructor(private service: QuickRepliesService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    const user = req.user as { id: string };
    return this.service.findAll(user.id);
  }

  @Post()
  create(@Body() body: CreateQuickReplyBody, @Req() req: Record<string, unknown>) {
    const user = req.user as { id: string };
    return this.service.create(body, user.id);
  }
}
