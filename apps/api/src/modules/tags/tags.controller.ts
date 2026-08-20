import { Controller, Get, Post, Delete, Body, Param, Query, Req, UseGuards } from '@nestjs/common';
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private tagsService: TagsService) {}

  /**
   * `?with_counts=1` devolve também quantos leads carregam cada tag. Fica opt-in
   * porque o seletor da ficha do lead não usa o número e não deve pagar por uma
   * varredura de leads a cada vez que alguém abre a lista.
   */
  @Get()
  findAll(
    @Req() req: Record<string, unknown>,
    @Query('with_counts') withCounts?: string,
  ) {
    const user = req.user as AuthUser;
    if (withCounts === '1' || withCounts === 'true') {
      return this.tagsService.findAllWithCounts(user);
    }
    return this.tagsService.findAll(user);
  }

  @Post()
  create(
    @Req() req: Record<string, unknown>,
    @Body('nome') nome: string,
    @Body('cor') cor: string = '#3498DB',
  ) {
    return this.tagsService.create(req.user as AuthUser, nome, cor);
  }

  @Delete(':id')
  remove(@Req() req: Record<string, unknown>, @Param('id') id: string) {
    return this.tagsService.remove(req.user as AuthUser, id);
  }
}
