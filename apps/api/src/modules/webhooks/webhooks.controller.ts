import { Controller, Post, Body, Headers, UnauthorizedException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Public } from '../../common/decorators/public.decorator';
import { PrismaService } from '../../common/prisma/prisma.service';
import { z } from 'zod';

const webhookSchema = z.object({
  event: z.string(),
  instance: z.string().optional(),
  data: z.record(z.unknown()).optional(),
}).passthrough();

@Controller('webhook')
export class WebhooksController {
  constructor(
    @InjectQueue('webhooks') private webhookQueue: Queue,
    private prisma: PrismaService,
  ) {}

  @Public()
  @Post('evolution')
  async handleEvolution(
    @Body() body: unknown,
    @Headers('apikey') apiKey: string,
  ) {
    if (apiKey !== process.env.EVOLUTION_API_KEY &&
        process.env.NODE_ENV === 'production') {
      throw new UnauthorizedException('Invalid API key');
    }

    const payload = webhookSchema.parse(body);

    await this.prisma.webhookLog.create({
      data: {
        event: payload.event,
        instance: payload.instance,
        payload: JSON.parse(JSON.stringify(payload)),
        processed: false,
      },
    });

    await this.webhookQueue.add(payload.event, payload, {
      jobId: `${payload.event}-${Date.now()}-${Math.random()}`,
    });

    return { received: true };
  }
}
