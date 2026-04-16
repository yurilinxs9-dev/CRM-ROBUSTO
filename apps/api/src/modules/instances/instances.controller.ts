import { Controller, Get, Post, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { InstancesService } from './instances.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('instances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InstancesController {
  constructor(private instancesService: InstancesService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.instancesService.findAll(req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.create(nome, req.user as AuthUser);
  }

  @Get(':nome/qr')
  @Roles(UserRole.GERENTE)
  getQrCode(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.getQrCode(nome, req.user as AuthUser);
  }

  @Get(':nome/status')
  status(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.checkStatus(nome, req.user as AuthUser);
  }

  @Post(':nome/reconnect')
  @Roles(UserRole.GERENTE)
  reconnect(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.reconnect(nome, req.user as AuthUser);
  }

  @Delete(':nome')
  @Roles(UserRole.GERENTE)
  delete(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.delete(nome, req.user as AuthUser);
  }
}
