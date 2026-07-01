import { Controller, Get, Post, Patch, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { InstancesService } from './instances.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const setSectorSchema = z.object({ sector_id: z.string().uuid().nullable() });

@Controller('instances')
@UseGuards(JwtAuthGuard, RolesGuard)
export class InstancesController {
  constructor(private instancesService: InstancesService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.instancesService.findAll(req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.OPERADOR)
  create(@Body('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.create(nome, req.user as AuthUser);
  }

  @Post('import-token')
  @Roles(UserRole.GERENTE)
  importByToken(
    @Body('nome') nome: string,
    @Body('uazapi_token') uazapiToken: string,
    @Req() req: Record<string, unknown>,
  ) {
    return this.instancesService.importByToken(nome, uazapiToken, req.user as AuthUser);
  }

  // Cria instância no gateway Evolution API (alternativa ao UazAPI). Retorna QR.
  @Post('evolution')
  @Roles(UserRole.OPERADOR)
  createEvolution(@Body('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.createEvolution(nome, req.user as AuthUser);
  }

  @Get(':nome/qr-evolution')
  @Roles(UserRole.OPERADOR)
  getQrCodeEvolution(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.getQrCodeEvolution(nome, req.user as AuthUser);
  }

  @Get(':nome/qr')
  @Roles(UserRole.OPERADOR)
  getQrCode(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.getQrCode(nome, req.user as AuthUser);
  }

  @Get(':nome/status')
  status(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.checkStatus(nome, req.user as AuthUser);
  }

  @Post(':nome/reconnect')
  @Roles(UserRole.OPERADOR)
  reconnect(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.reconnect(nome, req.user as AuthUser);
  }

  @Delete(':nome')
  @Roles(UserRole.OPERADOR)
  delete(@Param('nome') nome: string, @Req() req: Record<string, unknown>) {
    return this.instancesService.delete(nome, req.user as AuthUser);
  }

  // F-02: define o setor que atende este número (destino do round-robin).
  @Patch(':id/sector')
  @Roles(UserRole.GERENTE)
  setSector(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    const { sector_id } = setSectorSchema.parse(body);
    return this.instancesService.setSector(id, sector_id, req.user as AuthUser);
  }
}
