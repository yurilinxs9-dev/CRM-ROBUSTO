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

  @Public()
  @Post('wppconnect')
  async handleWppConnect(@Body() body: unknown) {
    const payload = webhookSchema.parse(body);

    // Normalize: WPPConnect uses `session`, Evolution used `instance`
    const normalized = {
      ...payload,
      instance: payload.session ?? payload.instance,
    };

    await this.prisma.webhookLog.create({
      data: {
        event: normalized.event,
        instance: normalized.instance,
        payload: JSON.parse(JSON.stringify(normalized)),
        processed: false,
      },
    });

    await this.webhookQueue.add(normalized.event, normalized, {
      jobId: `${normalized.event}-${Date.now()}-${Math.random()}`,
    });

    return { received: true };
  }
}
