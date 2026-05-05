import {
  Body,
  Controller,
  Logger,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
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

const webhookSchema = z.object({
  event: z.string(),
  session: z.string().optional(),
  instance: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

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
