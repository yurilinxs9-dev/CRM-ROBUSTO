import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { BroadcastsService } from './broadcasts.service';

const createSchema = z
  .object({
    name: z.string().min(1).max(120),
    stage_id: z.string().uuid().optional().nullable(),
    mode: z.enum(['template', 'ai']),
    template: z.string().max(2000).optional().nullable(),
    ai_instruction: z.string().max(2000).optional().nullable(),
    model_config_id: z.string().uuid().optional().nullable(),
    throttle_seconds: z.number().int().min(30).max(86_400).optional(),
    respect_ai_block: z.boolean().optional(),
    temperatura: z.string().optional().nullable(),
  })
  .strict();

/**
 * Follow-up / broadcast por IA. Criação e controle restritos a GERENTE+ (não
 * operador comum). O envio com throttle roda no BroadcastDispatcher.
 */
@Controller('broadcasts')
@UseGuards(JwtAuthGuard, RolesGuard)
export class BroadcastsController {
  constructor(private readonly svc: BroadcastsService) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Get()
  list(@Req() req: Request) {
    return this.svc.list(this.user(req));
  }

  @Get(':id')
  get(@Param('id') id: string, @Req() req: Request) {
    return this.svc.get(this.user(req), id);
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body() body: unknown, @Req() req: Request) {
    const dto = createSchema.parse(body);
    return this.svc.create(this.user(req), dto);
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
}
