import { Body, Controller, Delete, Get, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { PushService } from './push.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  userAgent: z.string().optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url() });

@Controller('push')
export class PushController {
  constructor(private readonly push: PushService) {}

  @Get('vapid-public-key')
  vapid() {
    return { publicKey: this.push.getPublicKey() };
  }

  @Post('subscribe')
  @UseGuards(JwtAuthGuard)
  async subscribe(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    const parsed = subscribeSchema.parse(body);
    const user = req.user as AuthUser;
    return this.push.subscribe(user.id, user.tenantId, parsed);
  }

  @Delete('unsubscribe')
  @UseGuards(JwtAuthGuard)
  async unsubscribe(@Body() body: unknown) {
    const parsed = unsubscribeSchema.parse(body);
    await this.push.unsubscribe(parsed.endpoint);
    return { ok: true };
  }
}
