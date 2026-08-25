import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadInsightsService } from './lead-insights.service';

/**
 * Rotas da ficha inteligente. Mesmo prefixo/guards do LeadsController — o
 * controle de acesso por lead vive no service, que delega ao LeadsService
 * (mesma regra do detalhe do lead: tenant, lead privado e visibilidade do
 * OPERADOR por instancia).
 */
@Controller('leads')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LeadInsightsController {
  constructor(private readonly insights: LeadInsightsService) {}

  @Get(':id/insight')
  obter(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.obter(id, req.user as AuthUser);
  }

  @Post(':id/insight/refresh')
  @Roles(UserRole.OPERADOR)
  refrescar(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.refrescar(id, req.user as AuthUser);
  }
}

/**
 * Radar comercial. Prefixo proprio (`/api/insights/radar`) porque a lista nao
 * pertence a um lead: e a fila de trabalho do usuario logado. Sem @Roles — o
 * recorte de quem ve o que ja e feito no `where` (mesma visibilidade da
 * listagem de leads), e leitura nao muda nada.
 */
@Controller('insights')
@UseGuards(JwtAuthGuard, RolesGuard)
export class RadarController {
  constructor(private readonly insights: LeadInsightsService) {}

  @Get('radar')
  radar(@Req() req: Record<string, unknown>) {
    return this.insights.radar(req.user as AuthUser);
  }
}
