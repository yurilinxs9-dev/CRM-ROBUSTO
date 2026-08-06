import { Controller, Get, Post, Patch, Delete, Body, Param, Req, UseGuards } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

@Controller('custom-fields')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomFieldsController {
  constructor(private customFields: CustomFieldsService) {}

  /** Compatibilidade: só os campos customizados do lead (formato antigo). */
  @Get()
  list(@Req() req: Record<string, unknown>) {
    return this.customFields.list(req.user as AuthUser);
  }

  /** Schema completo (grupos + campos dos três escopos) usado pela ficha nova. */
  @Get('schema')
  schema(@Req() req: Record<string, unknown>) {
    return this.customFields.schema(req.user as AuthUser);
  }

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.customFields.create(body, req.user as AuthUser);
  }

  // Precisa vir ANTES de @Patch(':id') — o Nest casa as rotas na ordem de
  // declaração, e 'reorder' seria capturado como um :id.
  @Post('reorder')
  @Roles(UserRole.GERENTE)
  reorder(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.customFields.reorder(body, req.user as AuthUser);
  }

  @Patch(':id')
  @Roles(UserRole.GERENTE)
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.customFields.update(id, body, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.customFields.deactivate(id, req.user as AuthUser);
  }
}

@Controller('custom-field-groups')
@UseGuards(JwtAuthGuard, RolesGuard)
export class CustomFieldGroupsController {
  constructor(private customFields: CustomFieldsService) {}

  @Post()
  @Roles(UserRole.GERENTE)
  create(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.customFields.createGroup(body, req.user as AuthUser);
  }

  @Patch(':id')
  @Roles(UserRole.GERENTE)
  update(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    return this.customFields.updateGroup(id, body, req.user as AuthUser);
  }

  @Delete(':id')
  @Roles(UserRole.GERENTE)
  remove(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.customFields.deleteGroup(id, req.user as AuthUser);
  }
}
