import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Param,
  Body,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { SectorsService } from './sectors.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const sectorBodySchema = z.object({ name: z.string().min(1).max(80) });

/**
 * F-01 — CRUD de setores. Gerenciado pelo admin do tenant (GERENTE+).
 * Leitura liberada para qualquer membro autenticado (popular dropdown).
 */
@Controller('sectors')
@UseGuards(JwtAuthGuard, RolesGuard)
export class SectorsController {
  constructor(private readonly sectors: SectorsService) {}

  // Lista setores ativos (dropdown). ?all=true inclui inativos (tela de admin).
  @Get()
  list(@Req() req: Record<string, unknown>, @Query('all') all?: string) {
    return this.sectors.list(req.user as AuthUser, all === 'true');
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Req() req: Record<string, unknown>, @Body() body: unknown) {
    const { name } = sectorBodySchema.parse(body);
    return this.sectors.create(req.user as AuthUser, name);
  }

  @Put(':id')
  @Roles(UserRole.GERENTE)
  update(@Req() req: Record<string, unknown>, @Param('id') id: string, @Body() body: unknown) {
    const { name } = sectorBodySchema.parse(body);
    return this.sectors.update(req.user as AuthUser, id, name);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  remove(@Req() req: Record<string, unknown>, @Param('id') id: string) {
    return this.sectors.softDelete(req.user as AuthUser, id);
  }
}
