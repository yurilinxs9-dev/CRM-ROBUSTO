import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { LeadInsightsService } from './lead-insights.service';

/**
 * Lembrete criado a mao pelo atendente. `z.object` descarta chave desconhecida:
 * um `origem: 'ia'` vindo do navegador nao pode virar lembrete de IA (nem
 * gastar a cota que o worker reserva para ela).
 *
 * `avisar_em` e DIA, nao instante: lembrete e compromisso de dia, e o
 * ancoramento no fuso de Sao Paulo e do service, que e quem tem relogio. O
 * regex so garante a forma — 2026-02-31 passa por aqui e morre la, com 400.
 */
export const criarLembreteSchema = z.object({
  motivo: z.string().trim().min(1).max(200),
  avisar_em: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Adiamento em DIAS. A UI oferece 1, 7 e 30; a faixa aceita ate 90 porque o
 * campo e do produto, nao do desenho atual do popover. Teto existe pelo mesmo
 * motivo do clamp do worker: lembrete para daqui a 10 anos e lembrete perdido.
 */
export const adiarLembreteSchema = z.object({ dias: z.number().int().min(1).max(90) });

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

  /**
   * Aceitar/recusar a etapa que a ficha sugeriu. Sem body: o que fazer esta na
   * rota e a etapa vem da propria ficha — mandar o `estagio_id` pelo cliente
   * abriria um segundo caminho para mover lead, sem sugestao nenhuma por tras.
   *
   * `@HttpCode(200)` porque nada e criado: as duas APAGAM a sugestao pendente.
   */
  @Post(':id/insight/etapa-sugerida/aceitar')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.OPERADOR)
  aceitarEtapa(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.aceitarEtapaSugerida(id, req.user as AuthUser);
  }

  @Post(':id/insight/etapa-sugerida/recusar')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.OPERADOR)
  recusarEtapa(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.recusarEtapaSugerida(id, req.user as AuthUser);
  }

  /**
   * Lembretes do lead. Sem @Roles, como o GET da ficha: leitura nao muda nada e
   * o recorte de quem ve o que ja e do LeadsService, dentro do service.
   */
  @Get(':id/lembretes')
  listarLembretes(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.listarLembretes(id, req.user as AuthUser);
  }

  /**
   * Lembrete criado a mao. Fica no controller da ficha porque nasce DENTRO de
   * um lead — as rotas de acao, que agem sobre um lembrete que ja existe, moram
   * no `LembretesController`.
   */
  @Post(':id/lembretes')
  @Roles(UserRole.OPERADOR)
  criarLembrete(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Record<string, unknown>,
  ) {
    return this.insights.criarLembrete(id, req.user as AuthUser, criarLembreteSchema.parse(body));
  }
}

/**
 * Acoes sobre um lembrete que ja existe. Prefixo proprio (`/api/lembretes/:id`)
 * porque a chave e o LEMBRETE, nao o lead: o card do radar tem o `lembrete_id`
 * em maos e nada mais — exigir o lead na URL faria a UI carregar um dado so
 * para montar o endereco, e abriria a porta para o par (lead, lembrete) chegar
 * incoerente. Quem descobre o lead (e decide o acesso por ele) e o service.
 *
 * `@HttpCode(200)` nas tres: nada e criado, so muda o estado do lembrete.
 */
@Controller('lembretes')
@UseGuards(JwtAuthGuard, RolesGuard)
export class LembretesController {
  constructor(private readonly insights: LeadInsightsService) {}

  @Post(':id/concluir')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.OPERADOR)
  concluir(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.concluirLembrete(id, req.user as AuthUser);
  }

  @Post(':id/descartar')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.OPERADOR)
  descartar(@Param('id') id: string, @Req() req: Record<string, unknown>) {
    return this.insights.descartarLembrete(id, req.user as AuthUser);
  }

  @Post(':id/adiar')
  @HttpCode(HttpStatus.OK)
  @Roles(UserRole.OPERADOR)
  adiar(@Param('id') id: string, @Body() body: unknown, @Req() req: Record<string, unknown>) {
    const { dias } = adiarLembreteSchema.parse(body);
    return this.insights.adiarLembrete(id, req.user as AuthUser, dias);
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
