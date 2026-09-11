import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Logger,
  Param,
  Post,
  Query,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { SkipThrottle } from '@nestjs/throttler';
import { Queue } from 'bullmq';
import { Request } from 'express';
import * as crypto from 'node:crypto';
import { z } from 'zod';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { hashTruncated } from '../../common/utils/hash-truncated';
import {
  WebhookContext,
  WebhookSecretGuard,
} from './guards/webhook-secret.guard';
import {
  extrairPhoneNumberIds,
  nomearEvento,
  resolverDesafio,
  verificarAssinatura,
  type QueryVerificacao,
} from './meta-signature';

const webhookSchema = z.object({
  event: z.string(),
  session: z.string().optional(),
  instance: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

@SkipThrottle()
@Controller('webhook')
export class WebhooksController {
  private readonly logger = new Logger(WebhooksController.name);

  constructor(
    @InjectQueue('webhooks') private webhookQueue: Queue,
    private prisma: PrismaService,
  ) {}

  private async resolveTenantByInstanceName(name: string | null): Promise<string | null> {
    if (!name) return null;
    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { nome: name },
      select: { tenant_id: true },
    });
    return inst?.tenant_id ?? null;
  }

  /**
   * Igual ao acima mas escopado a provider='evolution'. Nomes de instância só
   * são únicos por tenant no banco, mas o webhook Evolution só traz o nome —
   * quando há instâncias homônimas em tenants diferentes (UazAPI antiga vs
   * Evolution nova), o nome cru resolvia o tenant errado e o webhookLog era
   * gravado no tenant errado. Fallback ao nome cru se não houver Evolution.
   */
  private async resolveTenantByEvolutionInstance(name: string | null): Promise<string | null> {
    if (!name) return null;
    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { nome: name, config: { path: ['provider'], equals: 'evolution' } },
      select: { tenant_id: true },
    });
    if (inst) return inst.tenant_id;
    return this.resolveTenantByInstanceName(name);
  }

  private async resolveTenantByUazapiToken(token: string | undefined): Promise<string | null> {
    if (!token) return null;
    const inst = await this.prisma.whatsappInstance.findFirst({
      where: { config: { path: ['uazapi_token'], equals: token } },
      select: { tenant_id: true },
    });
    return inst?.tenant_id ?? null;
  }

  @Public()
  @Post('wppconnect')
  async handleWppConnect(@Body() body: unknown) {
    const payload = webhookSchema.parse(body);

    const normalized = {
      ...payload,
      instance: payload.session ?? payload.instance,
    };

    const tenantId = await this.resolveTenantByInstanceName(normalized.instance ?? null);

    await this.prisma.webhookLog.create({
      data: {
        event: normalized.event,
        instance: normalized.instance,
        payload: JSON.parse(JSON.stringify(normalized)),
        processed: false,
        tenant_id: tenantId,
      },
    });

    await this.webhookQueue.add(normalized.event, normalized, {
      jobId: `${normalized.event}-${Date.now()}-${Math.random()}`,
    });

    return { received: true };
  }

  @Public()
  @Post('evolution')
  async handleEvolution(@Body() body: unknown) {
    const payload = webhookSchema.parse(body);

    // Evolution v2 envia { event: 'messages.upsert' | 'connection.update' | ...,
    // instance, data }. Os handlers Evolution do WebhookProcessor já tratam
    // esses nomes de evento crus — basta enfileirar como wppconnect faz.
    const tenantId = await this.resolveTenantByEvolutionInstance(payload.instance ?? null);

    await this.prisma.webhookLog.create({
      data: {
        event: payload.event,
        instance: payload.instance,
        payload: JSON.parse(JSON.stringify(payload)),
        processed: false,
        tenant_id: tenantId,
      },
    });

    await this.webhookQueue.add(payload.event, payload, {
      jobId: `${payload.event}-${Date.now()}-${Math.random()}`,
    });

    return { received: true };
  }

  @Public()
  @Post('uazapi')
  async handleUazapi(@Body() body: unknown) {
    const payload = (body ?? {}) as Record<string, unknown>;
    const instanceField = payload.instance as Record<string, unknown> | undefined;
    const instanceName =
      (payload.instanceName as string | undefined) ??
      (payload.instanceId as string | undefined) ??
      (instanceField?.name as string | undefined) ??
      null;

    const tenantId =
      (await this.resolveTenantByUazapiToken(payload.token as string | undefined)) ??
      (await this.resolveTenantByInstanceName(instanceName));

    this.logger.warn({
      event: 'webhook.uazapi.legacy_endpoint_used',
      migration_eligible: tenantId !== null,
      instance_hint: instanceName ? hashTruncated(instanceName) : null,
    });

    return this.enqueueUazapi(payload, tenantId, instanceName);
  }

  @Public()
  @UseGuards(WebhookSecretGuard)
  @Post('uazapi/:instanceId/:webhookSecret')
  async handleUazapiAuthenticated(
    @Param('instanceId') _instanceId: string,
    @Body() body: Record<string, unknown>,
    @Req() req: Request,
  ) {
    const ctx = (req as Request & { webhookContext?: WebhookContext })
      .webhookContext;
    if (!ctx) {
      throw new UnauthorizedException();
    }

    const payloadToken = body?.token;
    if (typeof payloadToken !== 'string') {
      this.logger.warn({
        event: 'webhook.uazapi.payload_token_mismatch',
        reason: 'not_string',
        instance_id_hash: hashTruncated(ctx.instanceId),
      });
      throw new UnauthorizedException();
    }
    const providedToken = Buffer.from(payloadToken, 'utf8');
    const expectedToken = Buffer.from(ctx.uazapiToken, 'utf8');
    if (
      providedToken.length !== expectedToken.length ||
      !crypto.timingSafeEqual(providedToken, expectedToken)
    ) {
      this.logger.warn({
        event: 'webhook.uazapi.payload_token_mismatch',
        reason: 'mismatch',
        instance_id_hash: hashTruncated(ctx.instanceId),
      });
      throw new UnauthorizedException();
    }

    const instanceField = body.instance as Record<string, unknown> | undefined;
    const instanceName =
      (body.instanceName as string | undefined) ??
      (body.instanceId as string | undefined) ??
      (instanceField?.name as string | undefined) ??
      null;

    return this.enqueueUazapi(body, ctx.tenantId, instanceName);
  }

  // -------------------------------------------------------------------------
  // Meta — WhatsApp Cloud API (API oficial)
  // -------------------------------------------------------------------------
  //
  // Diferente dos outros dois providers em tres pontos que mudam o desenho:
  //
  //   1. A URL e UMA so para o App inteiro. Nao ha segredo por instancia na
  //      URL (UazAPI) nem nome de instancia no corpo (Evolution): o tenant sai
  //      do phone_number_id dentro do payload.
  //   2. A Meta valida a URL com um GET antes de mandar qualquer POST. Sem a
  //      rota GET abaixo, o webhook nao chega a ser aceito no painel.
  //   3. A autenticidade vem da assinatura HMAC do corpo bruto com o App
  //      Secret — por isso o main.ts guarda o buffer so nesta rota.

  /**
   * Resolve o tenant pelo numero que recebeu o evento.
   *
   * Enquanto nao houver instancia `meta_cloud` cadastrada isso devolve null, e
   * o evento e registrado sem tenant — mesmo comportamento dos outros
   * providers diante de instancia desconhecida.
   */
  private async resolveTenantByPhoneNumberId(
    phoneNumberIds: string[],
  ): Promise<string | null> {
    for (const id of phoneNumberIds) {
      const inst = await this.prisma.whatsappInstance.findFirst({
        where: { config: { path: ['phone_number_id'], equals: id } },
        select: { tenant_id: true },
      });
      if (inst) return inst.tenant_id;
    }
    return null;
  }

  /**
   * Handshake de verificacao do webhook.
   *
   * A resposta tem que ser o `hub.challenge` CRU — daí o Content-Type text/plain
   * explicito: o default do Nest para string e text/html, e a Meta ja recusou
   * configuracao por causa disso.
   *
   * Token errado responde 403, nao 200: um 200 generoso deixaria qualquer um
   * apontar o proprio App para esta URL.
   */
  @Public()
  @Get('meta')
  @Header('Content-Type', 'text/plain; charset=utf-8')
  verifyMeta(@Query() query: QueryVerificacao): string {
    const challenge = resolverDesafio(query, process.env.META_VERIFY_TOKEN ?? '');
    if (challenge === null) {
      this.logger.warn({
        event: 'webhook.meta.verify_rejected',
        mode: query['hub.mode'] ?? null,
        token_configurado: Boolean(process.env.META_VERIFY_TOKEN),
      });
      throw new ForbiddenException();
    }
    this.logger.log({ event: 'webhook.meta.verify_ok' });
    return challenge;
  }

  /**
   * Recebimento de eventos.
   *
   * Por ora apenas autentica e registra: o `webhook.processor` ainda nao tem
   * via para `meta.*`, e enfileirar agora so marcaria os eventos como
   * processados no default do switch — perdendo-os de vez. Ficam no WebhookLog
   * com processed=false, prontos para reprocessamento quando o handler existir.
   *
   * ATENCAO: o WebhookLog e podado em 7 dias (data-retention.service). Nao
   * assine o campo `messages` em producao antes do handler, ou mensagem real
   * de cliente entra aqui e expira sem ser atendida.
   */
  @Public()
  @Post('meta')
  async handleMeta(
    @Body() body: Record<string, unknown>,
    @Req() req: Request & { rawBody?: Buffer },
  ): Promise<{ received: true }> {
    const assinaturaOk = verificarAssinatura(
      req.rawBody,
      req.header('x-hub-signature-256'),
      process.env.META_APP_SECRET ?? '',
    );
    if (!assinaturaOk) {
      this.logger.warn({
        event: 'webhook.meta.bad_signature',
        tem_raw_body: Boolean(req.rawBody),
        segredo_configurado: Boolean(process.env.META_APP_SECRET),
      });
      throw new UnauthorizedException();
    }

    const phoneNumberIds = extrairPhoneNumberIds(body);
    const tenantId = await this.resolveTenantByPhoneNumberId(phoneNumberIds);
    const evento = nomearEvento(body);

    await this.prisma.webhookLog.create({
      data: {
        event: evento,
        instance: phoneNumberIds[0] ?? null,
        payload: JSON.parse(JSON.stringify(body)),
        processed: false,
        tenant_id: tenantId,
      },
    });

    this.logger.log({
      event: 'webhook.meta.received',
      tipo: evento,
      tenant_resolvido: tenantId !== null,
      numeros: phoneNumberIds.length,
    });

    // 200 imediato: a Meta reenvia o evento se demorarmos, e reenvio duplica
    // trabalho la na frente.
    return { received: true };
  }

  private async enqueueUazapi(
    body: Record<string, unknown>,
    tenantId: string | null,
    instanceName: string | null,
  ): Promise<{ received: true }> {
    const rawEvent =
      (body.EventType as string | undefined) ??
      (body.event as string | undefined) ??
      'unknown';
    const normalizedEvent = `uazapi.${rawEvent}`;

    const normalized: Record<string, unknown> = {
      ...body,
      event: normalizedEvent,
    };

    await this.prisma.webhookLog.create({
      data: {
        event: normalizedEvent,
        instance: instanceName,
        payload: JSON.parse(JSON.stringify(normalized)),
        processed: false,
        tenant_id: tenantId,
      },
    });

    await this.webhookQueue.add(normalizedEvent, normalized, {
      jobId: `${normalizedEvent}-${Date.now()}-${Math.random()}`,
    });

    return { received: true };
  }
}
