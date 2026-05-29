import { Controller, Get, Req, UseGuards } from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Anúncios ativos visíveis para QUALQUER usuário logado (banner/popup de
 * manutenção/instabilidade/recado). Só leitura — gestão é no /platform-admin.
 */
@Controller('announcements')
@UseGuards(JwtAuthGuard)
export class AnnouncementsController {
  constructor(private readonly svc: PlatformAdminService) {}

  @Get('active')
  active(@Req() req: Record<string, unknown>) {
    return this.svc.activeFor(req.user as AuthUser);
  }
}
