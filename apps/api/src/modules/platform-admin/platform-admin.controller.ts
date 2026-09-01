import {
  Body,
  Controller,
  Delete,
  Get,
  Logger,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { PlatformAdminService } from './platform-admin.service';
import { PlatformAdminGuard } from './platform-admin.guard';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';
import { PlatformScopes } from './platform-scopes.decorator';
import { HistorySyncService } from '../webhooks/history-sync.service';
import { historySyncRequestSchema } from '../webhooks/history-sync';

const bannedSchema = z.object({ banned: z.boolean() });
const suspendedSchema = z.object({ suspended: z.boolean() });
const activeSchema = z.object({ active: z.boolean() });
// deep: varre o miolo das conversas (ignora a prova de "chat em dia"). 1 fetch
// por chat SEMPRE e em lote global — daí o teto de janela do schema.
const historySyncSchema = historySyncRequestSchema;

/**
 * TODA rota daqui declara seu escopo. O guard é fail-closed: rota nova sem
 * @PlatformScopes só é acessível ao admin master ('*'). O escopo abre a ÁREA;
 * quem protege o tenant do master dentro da área é o service
 * (`assertTenantAllowed`), porque o admin restrito tem as mesmas telas — só
 * não alcança aquele tenant nem os usuários dele.
 */
@Controller('platform-admin')
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
export class PlatformAdminController {
  private readonly logger = new Logger(PlatformAdminController.name);

  constructor(
    private readonly svc: PlatformAdminService,
    private readonly historySync: HistorySyncService,
  ) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Get('stats')
  @PlatformScopes('overview')
  stats() {
    return this.svc.stats();
  }

  @Get('tenants')
  @PlatformScopes('tenants')
  tenants(@Req() req: Request) {
    return this.svc.listTenants(this.user(req));
  }

  @Get('tenants/:id')
  @PlatformScopes('tenants')
  tenant(@Param('id') id: string, @Req() req: Request) {
    return this.svc.getTenant(this.user(req), id);
  }

  @Get('logs')
  @PlatformScopes('logs')
  logs(@Req() req: Request) {
    return this.svc.logs(this.user(req));
  }

  @Get('health')
  @PlatformScopes('health')
  health() {
    return this.svc.health();
  }

  // Saúde das instâncias (monitor + alerta em aberto). Leitura de operação:
  // acompanha o escopo do `health` acima.
  @Get('instances-health')
  @PlatformScopes('health')
  instancesHealth(@Req() req: Request) {
    return this.svc.instancesHealth(this.user(req));
  }

  @Patch('users/:id/ban')
  @PlatformScopes('tenant_actions')
  banUser(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { banned } = bannedSchema.parse(body);
    return this.svc.setUserBanned(this.user(req), id, banned);
  }

  @Delete('users/:id')
  @PlatformScopes('tenant_actions')
  deleteUser(@Param('id') id: string, @Req() req: Request) {
    return this.svc.deleteUser(this.user(req), id);
  }

  @Delete('tenants/:id')
  @PlatformScopes('tenant_actions')
  deleteTenant(@Param('id') id: string, @Req() req: Request) {
    return this.svc.deleteTenant(this.user(req), id);
  }

  @Patch('tenants/:id/suspend')
  @PlatformScopes('tenant_actions')
  suspendTenant(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { suspended } = suspendedSchema.parse(body);
    return this.svc.setTenantSuspended(this.user(req), id, suspended);
  }

  // Cobrança manual. As duas MUTAÇÕES seguem `tenants/:id/suspend`
  // (`tenant_actions`) — quem pode suspender um cliente é quem cuida da
  // cobrança dele. O resumo é LEITURA e segue os GETs vizinhos (`tenants`),
  // porque ele alimenta os KPIs da própria tela de clientes: exigir
  // `tenant_actions` num GET quebraria a tela de um admin só-leitura.
  // O body vai cru para o service, que valida com Zod (padrão do
  // createAnnouncement).
  @Patch('tenants/:id/billing')
  @PlatformScopes('tenant_actions')
  setBilling(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    return this.svc.setTenantBilling(this.user(req), id, body);
  }

  @Post('tenants/:id/billing/mark-paid')
  @PlatformScopes('tenant_actions')
  markPaid(@Param('id') id: string, @Req() req: Request) {
    return this.svc.markTenantPaid(this.user(req), id);
  }

  @Get('billing-summary')
  @PlatformScopes('tenants')
  billingSummary(@Req() req: Request) {
    return this.svc.billingSummary(this.user(req));
  }

  // Re-sync de histórico UazAPI de TODAS as instâncias conectadas (todos os
  // tenants) — repara buracos de webhook em lote. Roda em background.
  @Post('history-sync')
  @PlatformScopes('tenant_actions')
  startHistorySync(@Body() body: unknown) {
    const { days = 30, deep = false } = historySyncSchema.parse(body ?? {});
    void this.historySync
      .syncAllUazapi(days * 24 * 3_600_000, deep)
      .then((r) => {
        const total = r.reduce((acc, s) => acc + s.messages_enqueued, 0);
        const chats = r.reduce((acc, s) => acc + s.chats_scanned, 0);
        this.logger.log(
          `history sync global${deep ? ' DEEP' : ''} concluido: ${chats} chats varridos, ` +
            `${total} msgs re-injetadas`,
        );
      })
      .catch((err) => this.logger.warn(`history sync global falhou: ${String(err)}`));
    return { started: true, days, deep };
  }

  @Post('impersonate/:userId')
  @PlatformScopes('tenant_actions')
  impersonate(@Param('userId') userId: string, @Req() req: Request) {
    return this.svc.impersonate(this.user(req), userId, req.ip);
  }

  @Get('announcements')
  @PlatformScopes('announcements')
  listAnnouncements(@Req() req: Request) {
    return this.svc.listAnnouncements(this.user(req));
  }

  @Post('announcements')
  @PlatformScopes('announcements')
  createAnnouncement(@Body() body: unknown, @Req() req: Request) {
    return this.svc.createAnnouncement(this.user(req), body);
  }

  @Patch('announcements/:id')
  @PlatformScopes('announcements')
  setActive(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const { active } = activeSchema.parse(body);
    return this.svc.setAnnouncementActive(this.user(req), id, active);
  }
}
