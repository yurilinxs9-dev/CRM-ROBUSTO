import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { InstancesService } from './instances.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('instances')
@UseGuards(JwtAuthGuard)
export class InstancesController {
  constructor(private instancesService: InstancesService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.instancesService.findAll(req.user as AuthUser);
  }

  @Post()
  create(@Body('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.create(nome, req.user as AuthUser);
  }

  @Get(':nome/qr')
  getQrCode(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.getQrCode(nome, req.user as AuthUser);
  }

  @Get(':nome/status')
  status(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.checkStatus(nome, req.user as AuthUser);
  }

  @Post(':nome/reconnect')
  reconnect(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.reconnect(nome, req.user as AuthUser);
  }

  @Delete(':nome')
  delete(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.delete(nome, req.user as AuthUser);
  }
}
