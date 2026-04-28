import { Controller, Patch, Req, Body, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { TenantsService } from './tenants.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const updateSettingsSchema = z.object({
  pool_enabled: z.boolean().optional(),
  prefix_enabled: z.boolean().optional(),
});

@Controller('tenants')
@UseGuards(JwtAuthGuard, RolesGuard)
export class TenantsController {
  constructor(private tenantsService: TenantsService) {}

  @Patch('settings')
  @Roles(UserRole.GERENTE)
  updateSettings(@Req() req: Record<string, unknown>, @Body() body: unknown) {
    const dto = updateSettingsSchema.parse(body);
    return this.tenantsService.updateSettings(req.user as AuthUser, dto);
  }
}
