import { Processor, WorkerHost } from '@nestjs/bullmq';
import { HttpService } from '@nestjs/axios';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { firstValueFrom } from 'rxjs';
import * as crypto from 'node:crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { OUTBOUND_WEBHOOKS_QUEUE, DispatchJobData } from './outbound-webhooks.queue';

@Processor(OUTBOUND_WEBHOOKS_QUEUE, { concurrency: 10 })
export class OutboundWebhooksProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboundWebhooksProcessor.name);

  constructor(
    private readonly http: HttpService,
    private readonly prisma: PrismaService,
  ) {
    super();
  }

  async process(job: Job<DispatchJobData>): Promise<void> {
    const { webhookId, eventType, payload } = job.data;
    const wh = await this.prisma.outboundWebhook.findUnique({ where: { id: webhookId } });
    if (!wh || !wh.active) {
      this.logger.warn(`Webhook ${webhookId} inativo/removido — skip`);
      return;
    }

    const body = JSON.stringify(payload);
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-CRM-Event': eventType,
      'X-CRM-Delivery': job.id ?? crypto.randomUUID(),
    };
    if (wh.secret) {
      const sig = crypto.createHmac('sha256', wh.secret).update(body).digest('hex');
      headers['X-CRM-Signature'] = `sha256=${sig}`;
    }
    if (wh.custom_headers && typeof wh.custom_headers === 'object') {
      for (const [k, v] of Object.entries(wh.custom_headers as Record<string, unknown>)) {
        if (typeof v === 'string') headers[k] = v;
      }
    }

    const start = Date.now();
    let statusCode: number | null = null;
    let responseBody: string | null = null;
    let success = false;
    let error: string | null = null;

    try {
      const res = await firstValueFrom(
        this.http.post(wh.url, body, {
          headers,
          timeout: 15_000,
          validateStatus: () => true,
          maxRedirects: 3,
        }),
      );
      statusCode = res.status;
      responseBody = typeof res.data === 'string'
        ? res.data.slice(0, 2000)
        : JSON.stringify(res.data).slice(0, 2000);
      success = res.status >= 200 && res.status < 300;
      if (!success) error = `HTTP ${res.status}`;
    } catch (e) {
      error = (e as Error).message?.slice(0, 500) ?? 'unknown error';
    }

    const duration = Date.now() - start;

    await this.prisma.webhookDelivery.create({
      data: {
        webhook_id: wh.id,
        event_type: eventType,
        payload: payload as object,
        status_code: statusCode,
        response_body: responseBody,
        success,
        error,
        duration_ms: duration,
        attempt: job.attemptsMade + 1,
      },
    });

    if (!success) {
      throw new Error(error ?? `HTTP ${statusCode ?? 'unknown'}`);
    }
  }
}
