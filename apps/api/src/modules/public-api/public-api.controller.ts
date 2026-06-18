import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseFilters,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request } from 'express';
import { PublicApiService } from './public-api.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ScopesGuard } from './guards/scopes.guard';
import { PublicRateLimitGuard } from './guards/public-rate-limit.guard';
import { IdempotencyInterceptor } from './idempotency.interceptor';
import { AuditInterceptor } from './audit.interceptor';
import { PublicExceptionFilter } from './public-exception.filter';
import { RequireScopes } from './scopes';
import type { ApiAuth } from './api-auth';

interface ApiRequest extends Request {
  apiAuth?: ApiAuth;
}

/**
 * API HTTP RESTful pública para integrações externas (n8n, Zapier, etc).
 * Base: /api/v1  (o prefixo global "api" vem do main.ts).
 * Auth: Authorization: Bearer <api_key>  ·  Content-Type: application/json
 *
 * Terminologia do contrato externo ↔ domínio interno:
 *   user / contact   → Lead
 *   conversation     → Lead (thread de mensagens); conversation_id == lead id
 */
@Controller({ path: 'v1' })
@UseGuards(ApiKeyGuard, PublicRateLimitGuard, ScopesGuard)
@UseInterceptors(AuditInterceptor, IdempotencyInterceptor)
@UseFilters(PublicExceptionFilter)
export class PublicApiController {
  constructor(private readonly svc: PublicApiService) {}

  private tenantId(req: ApiRequest): string {
    return (req.apiAuth as ApiAuth).tenantId;
  }

  private isAi(req: ApiRequest): boolean {
    return (req.apiAuth as ApiAuth).isAi === true;
  }

  // 2.1 — Buscar usuários/contatos
  @Get('users')
  @RequireScopes('contacts:read')
  listUsers(@Req() req: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.svc.listContacts(this.tenantId(req), query);
  }

  @Get('users/:id')
  @RequireScopes('contacts:read')
  getUser(@Param('id') id: string, @Req() req: ApiRequest) {
    return this.svc.getContact(this.tenantId(req), id);
  }

  // 2.1b — Criar contato
  @Post('users')
  @HttpCode(201)
  @RequireScopes('contacts:write')
  createUser(@Body() body: unknown, @Req() req: ApiRequest) {
    return this.svc.createContact(this.tenantId(req), body);
  }

  // 2.1c — Atualizar contato
  @Patch('users/:id')
  @RequireScopes('contacts:write')
  updateUser(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.svc.updateContact(this.tenantId(req), id, body);
  }

  // Listar conversas (filtro ?status= ?tag= ?limit= ?offset=)
  @Get('conversations')
  @RequireScopes('conversations:read')
  listConversations(@Req() req: ApiRequest, @Query() query: Record<string, unknown>) {
    return this.svc.listConversations(this.tenantId(req), query);
  }

  // Histórico da conversa (contato + mensagens recentes)
  @Get('conversations/:id')
  @RequireScopes('conversations:read')
  getConversation(
    @Param('id') id: string,
    @Req() req: ApiRequest,
    @Query() query: Record<string, unknown>,
  ) {
    return this.svc.getConversation(this.tenantId(req), id, query);
  }

  // 2.2 — Enviar nova conversa/mensagem
  @Post('conversations')
  @HttpCode(201)
  @RequireScopes('conversations:write')
  sendConversation(@Body() body: unknown, @Req() req: ApiRequest) {
    return this.svc.sendMessage(this.tenantId(req), body, this.isAi(req));
  }

  // Variante aninhada /users/:id/conversations
  @Post('users/:id/conversations')
  @HttpCode(201)
  @RequireScopes('conversations:write')
  sendForUser(
    @Param('id') id: string,
    @Body() body: Record<string, unknown>,
    @Req() req: ApiRequest,
  ) {
    return this.svc.sendMessage(this.tenantId(req), { ...body, user_id: id }, this.isAi(req));
  }

  // 2.3 — Atualizar status da conversa
  @Patch('conversations/:id/status')
  @RequireScopes('conversations:write')
  updateStatus(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.svc.updateStatus(this.tenantId(req), id, body);
  }

  // 2.4 — Adicionar etiquetas (tags) à conversa
  @Post('conversations/:id/tags')
  @HttpCode(201)
  @RequireScopes('tags:write')
  addTags(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.svc.addTags(this.tenantId(req), id, body);
  }

  // 2.5 — Listar setores do tenant (para descobrir o sector_id)
  @Get('sectors')
  @RequireScopes('conversations:read')
  listSectors(@Req() req: ApiRequest) {
    return this.svc.listSectors(this.tenantId(req));
  }

  // 2.6 — Transferir conversa para um setor (round-robin entre os agentes ativos)
  @Post('conversations/:id/sector')
  @RequireScopes('conversations:write')
  moveToSector(@Param('id') id: string, @Body() body: unknown, @Req() req: ApiRequest) {
    return this.svc.moveToSector(this.tenantId(req), id, body);
  }
}
