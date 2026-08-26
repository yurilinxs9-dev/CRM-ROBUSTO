import { Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
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
 * Query do radar. `z.object` descarta chave desconhecida: nada da querystring
 * chega ao `where` sem passar por aqui.
 *
 * `pipeline_id` NAO e validado como uuid, de proposito. Existe em producao um
 * pipeline com id "pipeline-default" (tenant Default Workspace, resquicio de
 * seed antigo) referenciado por stages e leads reais — o mesmo motivo pelo qual
 * `createLeadSchema.pipeline_id` em leads.service.ts e `z.string().min(1)`.
 * Formato de id nao e regra de negocio: o recorte que importa (tenant e
 * visibilidade) ja esta no `where` do radar, e um funil de outro tenant
 * simplesmente nao devolve lead nenhum.
 *
 * String vazia vale como ausente: o select "Todos os funis" da tela manda `''`,
 * e um `.optional()` cru devolveria 400 para o estado inicial da pagina.
 */
export const radarQuerySchema = z.object({
  pipeline_id: z.preprocess(
    (v) => (v === '' || v === null ? undefined : v),
    z.string().min(1).optional(),
  ),
});

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
  radar(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    const { pipeline_id } = radarQuerySchema.parse(query);
    return this.insights.radar(req.user as AuthUser, pipeline_id);
  }
}
