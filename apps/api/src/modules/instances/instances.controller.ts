import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { InstancesService } from './instances.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';

@Controller('instances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InstancesController {
  constructor(private instancesService: InstancesService) {}

  @Get()
  @Roles(UserRole.GERENTE)
  findAll() {
    return this.instancesService.findAll();
  }

  @Post()
  @Roles(UserRole.SUPER_ADMIN)
  create(@Body('nome') nome: string) {
    return this.instancesService.create(nome);
  }

  @Get(':nome/qr')
  @Roles(UserRole.SUPER_ADMIN)
  getQrCode(@Param('nome') nome: string) {
    return this.instancesService.getQrCode(nome);
  }

  @Post(':nome/reconnect')
  @Roles(UserRole.SUPER_ADMIN)
  reconnect(@Param('nome') nome: string) {
    return this.instancesService.reconnect(nome);
  }
}
