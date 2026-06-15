import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../platform-admin/platform-admin.guard';
import type { AuthUser } from '../../common/types/auth-user';
import { AiConfigService } from './ai-config.service';
import { createModelSchema, updateAgentSchema, updateModelSchema } from './ai.dto';

/**
 * Painel de IA — restrito ao admin de plataforma (PlatformAdminGuard verifica
 * is_platform_admin no banco). Gerencia modelos (qualquer provedor/modelo) e a
 * config global do agente. As chaves nunca são retornadas (só máscara).
 */
@Controller('ai')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class AiConfigController {
  constructor(private readonly svc: AiConfigService) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Get('models')
  listModels() {
    return this.svc.listModels();
  }

  @Post('models')
  createModel(@Body() body: unknown, @Req() req: Request) {
    const dto = createModelSchema.parse(body);
    return this.svc.createModel(this.user(req).id, dto);
  }

  @Put('models/:id')
  updateModel(@Param('id') id: string, @Body() body: unknown) {
    const dto = updateModelSchema.parse(body);
    return this.svc.updateModel(id, dto);
  }

  @Delete('models/:id')
  deleteModel(@Param('id') id: string) {
    return this.svc.deleteModel(id);
  }

  @Post('models/:id/test')
  testModel(@Param('id') id: string) {
    return this.svc.testModel(id);
  }

  @Get('agent')
  getAgent() {
    return this.svc.getAgentConfig();
  }

  @Patch('agent')
  updateAgent(@Body() body: unknown) {
    const dto = updateAgentSchema.parse(body);
    return this.svc.updateAgentConfig(dto);
  }
}
