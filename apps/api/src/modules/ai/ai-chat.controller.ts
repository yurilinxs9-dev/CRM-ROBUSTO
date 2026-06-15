import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';
import { AiChatService } from './ai-chat.service';

const copilotSchema = z.object({
  lead_id: z.string().uuid().optional().nullable(),
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1) }))
    .min(1)
    .max(40),
});

const suggestSchema = z.object({ lead_id: z.string().uuid() });

/**
 * Endpoints de IA do atendente (qualquer usuário autenticado). Os toggles
 * globais são verificados no service. Nada é enviado ao cliente aqui.
 */
@Controller('ai')
@UseGuards(JwtAuthGuard)
export class AiChatController {
  constructor(private readonly chat: AiChatService) {}

  private user(req: Request): AuthUser {
    return (req as unknown as { user: AuthUser }).user;
  }

  @Post('copilot')
  copilot(@Body() body: unknown, @Req() req: Request) {
    const dto = copilotSchema.parse(body);
    return this.chat.copilot(this.user(req), dto);
  }

  @Post('suggest-reply')
  suggest(@Body() body: unknown, @Req() req: Request) {
    const { lead_id } = suggestSchema.parse(body);
    return this.chat.suggestReply(this.user(req), lead_id);
  }
}
