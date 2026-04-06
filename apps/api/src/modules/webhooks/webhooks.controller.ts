import { Controller, Post, Body } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { z } from 'zod';

const webhookSchema = z.object({
  event: z.string(),
  session: z.string().optional(),
  instance: z.string().optional(),
  data: z.unknown().optional(),
}).passthrough();

@Controller('webhook')
export class WebhooksController {
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
    const rawEvent =
      (payload.EventType as string | undefined) ??
      (payload.event as string | undefined) ??
      'unknown';
    const normalizedEvent = `uazapi.${rawEvent}`;

    const instanceField = payload.instance as Record<string, unknown> | undefined;
    const instanceName =
      (payload.instanceName as string | undefined) ??
      (payload.instanceId as string | undefined) ??
      (instanceField?.name as string | undefined) ??
      null;

    const normalized: Record<string, unknown> = {
      ...payload,
      event: normalizedEvent,
    };

    const tenantId =
      (await this.resolveTenantByUazapiToken(payload.token as string | undefined)) ??
      (await this.resolveTenantByInstanceName(instanceName));

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
