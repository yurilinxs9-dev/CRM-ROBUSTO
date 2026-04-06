import { Controller, Get, Post, Body, Req, UseGuards } from '@nestjs/common';
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private tagsService: TagsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.tagsService.findAll(req.user as AuthUser);
  }

  @Post()
  create(
    @Req() req: Record<string, unknown>,
    @Body('nome') nome: string,
    @Body('cor') cor: string = '#3498DB',
  ) {
    return this.tagsService.create(req.user as AuthUser, nome, cor);
  }
}
