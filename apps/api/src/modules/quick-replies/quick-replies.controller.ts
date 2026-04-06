import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { QuickRepliesService } from './quick-replies.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

interface CreateQuickReplyBody { titulo: string; conteudo: string; is_global?: boolean; }

@Controller('quick-replies')
@UseGuards(JwtAuthGuard)
export class QuickRepliesController {
  constructor(private service: QuickRepliesService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.service.findAll(req.user as AuthUser);
  }

  @Post()
  create(@Body() body: CreateQuickReplyBody, @Req() req: Record<string, unknown>) {
    return this.service.create(body, req.user as AuthUser);
  }
}
