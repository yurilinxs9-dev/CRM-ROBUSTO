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
} from '@nestjs/common';
import type { Request } from 'express';
import { PublicApiService } from './public-api.service';
import { ApiKeyGuard } from './guards/api-key.guard';
import { ScopesGuard } from './guards/scopes.guard';
import { PublicRateLimitGuard } from './guards/public-rate-limit.guard';
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
@UseFilters(PublicExceptionFilter)
export class PublicApiController {
  constructor(private readonly svc: PublicApiService) {}

  private tenantId(req: ApiRequest): string {
    return (req.apiAuth as ApiAuth).tenantId;
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
    return this.svc.sendMessage(this.tenantId(req), body);
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
    return this.svc.sendMessage(this.tenantId(req), { ...body, user_id: id });
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
}
