import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { TagsService } from './tags.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

@Controller('tags')
@UseGuards(JwtAuthGuard)
export class TagsController {
  constructor(private tagsService: TagsService) {}

  @Get()
  findAll() {
    return this.tagsService.findAll();
  }

  @Post()
  create(
    @Body('nome') nome: string,
    @Body('cor') cor: string = '#3498DB',
  ) {
    return this.tagsService.create(nome, cor);
  }
}
