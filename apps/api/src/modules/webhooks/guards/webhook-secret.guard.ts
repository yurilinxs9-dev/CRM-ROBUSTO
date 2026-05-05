import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';
import * as crypto from 'node:crypto';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { hashTruncated } from '../../../common/utils/hash-truncated';

export interface WebhookContext {
  instanceId: string;
  tenantId: string;
  uazapiToken: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class WebhookSecretGuard implements CanActivate {
  private readonly logger = new Logger(WebhookSecretGuard.name);

  constructor(private prisma: PrismaService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx
      .switchToHttp()
      .getRequest<Request & { webhookContext?: WebhookContext }>();
    const params = req.params as { instanceId?: string; webhookSecret?: string };
    const { instanceId, webhookSecret } = params;

    if (!instanceId || !webhookSecret) {
      throw this.buildReject('missing_params', null);
    }

    if (!UUID_RE.test(instanceId)) {
      throw this.buildReject('invalid_instance_id_format', instanceId);
    }

    const instance = await this.prisma.whatsappInstance.findUnique({
      where: { id: instanceId },
      select: {
        id: true,
        tenant_id: true,
        webhook_secret: true,
        config: true,
      },
    });

    if (!instance) {
      throw this.buildReject('instance_not_found', instanceId);
    }
    if (!instance.webhook_secret) {
      throw this.buildReject('secret_null', instanceId);
    }

    const stored = Buffer.from(instance.webhook_secret, 'utf8');
    const provided = Buffer.from(webhookSecret, 'utf8');
    if (
      stored.length !== provided.length ||
      !crypto.timingSafeEqual(stored, provided)
    ) {
      throw this.buildReject('secret_mismatch', instanceId);
    }

    const uazapiToken = (instance.config as { uazapi_token?: string } | null)
      ?.uazapi_token;
    if (!uazapiToken) {
      throw this.buildReject('uazapi_token_missing', instanceId);
    }

    req.webhookContext = {
      instanceId: instance.id,
      tenantId: instance.tenant_id,
      uazapiToken,
    };

    this.logger.log({
      event: 'webhook.uazapi.guard.accept',
      instance_id_hash: hashTruncated(instance.id),
    });
    return true;
  }

  private buildReject(
    reason: string,
    instanceId: string | null,
  ): UnauthorizedException {
    this.logger.warn({
      event: 'webhook.uazapi.guard.reject',
      reason,
      instance_id_hash: instanceId ? hashTruncated(instanceId) : null,
    });
    return new UnauthorizedException();
  }
}
