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
  round_robin_enabled: z.boolean().optional(),
  share_history_enabled: z.boolean().optional(),
  // Janela de disparo do follow-up. `end` aceita 24 porque o limite superior é
  // exclusivo: 0–24 significa o dia inteiro. A coerência (start < end) é
  // validada no service, que enxerga também o valor já gravado.
  broadcast_window_start: z.number().int().min(0).max(23).optional(),
  broadcast_window_end: z.number().int().min(1).max(24).optional(),
  broadcast_window_days: z.array(z.number().int().min(1).max(7)).optional(),
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
