import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { BroadcastsService } from './broadcasts.service';

import { campaignSchema as createSchema, previewSchema, audienceSchema } from './broadcast-config';

/**
 * Follow-up / broadcast por IA. Criação e controle restritos a GERENTE+ (não
 * operador comum). O envio com throttle roda no BroadcastDispatcher.
 */
@Controller('broadcasts')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.GERENTE)
export class BroadcastsController {
  constructor(private readonly svc: BroadcastsService) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.user(req));
  }

  @Post('audience')
  audience(@Body() body: unknown, @Req() req: Request) {
    return this.svc.audience(this.user(req), audienceSchema.parse(body));
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.svc.update(this.user(req), id, createSchema.parse(body));
  }

  @Post(':id/duplicate')
  duplicate(@Param('id') id: string, @Req() req: Request) {
    return this.svc.duplicate(this.user(req), id);
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {
    return this.svc.get(this.user(req), id);
  }

  @Get(':id/targets')
  targets(@Param('id') id: string, @Req() req: Request) {
    return this.svc.targets(this.user(req), id);
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body() body: unknown, @Req() req: Request) {
    const dto = createSchema.parse(body);
    return this.svc.create(this.user(req), dto);
  }

  /** Gera um exemplo da mensagem (sem enviar) pra validar antes de criar. */
  @Post('preview')
  @Roles(UserRole.GERENTE)
  preview(@Body() body: unknown, @Req() req: Request) {
    const dto = previewSchema.parse(body);
    return this.svc.preview(this.user(req), dto);
  }

  @Post(':id/start')
  @Roles(UserRole.GERENTE)
  start(@Param('id') id: string, @Req() req: Request) {
    return this.svc.start(this.user(req), id);
  }

  @Post(':id/pause')
  @Roles(UserRole.GERENTE)
  pause(@Param('id') id: string, @Req() req: Request) {
    return this.svc.pause(this.user(req), id);
  }

  @Post(':id/cancel')
  @Roles(UserRole.GERENTE)
  cancel(@Param('id') id: string, @Req() req: Request) {
    return this.svc.cancel(this.user(req), id);
  }

  /** Reenfileira alvos com falha (failed → pending) e retoma o disparo. */
  @Post(':id/retry')
  @Roles(UserRole.GERENTE)
  retry(@Param('id') id: string, @Req() req: Request) {
    return this.svc.retryFailed(this.user(req), id);
  }

  /** Envio separado: dispara AGORA um lead específico da fila (conta no limite diário). */
  @Post(':id/send-now/:leadId')
  @Roles(UserRole.GERENTE)
  sendNow(@Param('id') id: string, @Param('leadId') leadId: string, @Req() req: Request) {
    return this.svc.sendNow(this.user(req), id, leadId);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  remove(@Param('id') id: string, @Req() req: Request) {
    return this.svc.remove(this.user(req), id);
  }
}
