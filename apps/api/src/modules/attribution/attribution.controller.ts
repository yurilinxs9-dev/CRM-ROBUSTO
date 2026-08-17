import { Body, Controller, Get, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AttributionService } from './attribution.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Relatório de origem dos leads. Vive fora do AnalyticsController de propósito:
 * um módulo novo não deveria poder quebrar os oito relatórios que já rodam.
 */
@Controller('attribution')
@UseGuards(JwtAuthGuard)
export class AttributionController {
  constructor(private readonly svc: AttributionService) {}

  /** Leads, ganhos e conversão por canal, mais o recorte pago × orgânico. */
  @Get('summary')
  getSummary(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.svc.getSummary(req.user as AuthUser, query);
  }

  /** Campanhas e palavras-chave do período. */
  @Get('campaigns')
  getCampaigns(@Req() req: Record<string, unknown>, @Query() query: Record<string, string>) {
    return this.svc.getCampaigns(req.user as AuthUser, query);
  }

  /** Dá um nome amigável a uma campanha (substitui a API do Google). */
  @Post('campaign-label')
  setCampaignLabel(@Req() req: Record<string, unknown>, @Body() body: unknown) {
    return this.svc.setCampaignLabel((req.user as AuthUser).tenantId, body);
  }

  /** Token público do site, para montar o snippet. Criado na primeira leitura. */
  @Get('site-token')
  async getSiteToken(@Req() req: Record<string, unknown>) {
    const token = await this.svc.getSiteToken((req.user as AuthUser).tenantId);
    return { site_token: token };
  }
}
