import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyService } from './api-key.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Gestão de API keys pelo app interno (frontend). Protegido por JWT + RolesGuard
 * (GERENTE+). Diferente do PublicApiController, que é autenticado por API key.
 * Rota: /api/api-keys
 */
@Controller('api-keys')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ApiKeysController {
  constructor(private readonly keys: ApiKeyService) {}

  private tenantId(req: Record<string, unknown>): string {
    return (req.user as AuthUser).tenantId;
  }

  @Get()
  @Roles(UserRole.GERENTE)
  list(@Req() req: Record<string, unknown>) {
    return this.keys.list(this.tenantId(req));
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.keys.create(this.tenantId(req), body);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  revoke(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.keys.revoke(this.tenantId(req), id);
  }
}
