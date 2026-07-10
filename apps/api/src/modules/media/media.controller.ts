import { Body, Controller, NotFoundException, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { v4 as uuid } from 'uuid';
import { MediaService } from './media.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const uploadUrlSchema = z.object({
  lead_id: z.string().uuid(),
  filename: z.string().min(1).max(200),
  mimetype: z.string().min(3).max(120),
});

/** Extensão segura a partir do filename (fallback bin). */
function safeExt(filename: string): string {
  const m = /\.([a-zA-Z0-9]{1,8})$/.exec(filename);
  return m ? m[1].toLowerCase() : 'bin';
}

@Controller('media')
@UseGuards(JwtAuthGuard, RolesGuard)
export class MediaController {
  constructor(
    private media: MediaService,
    private prisma: PrismaService,
  ) {}

  /**
   * Upload direto ao Storage: o front pede a URL, faz PUT do arquivo direto no
   * Supabase e depois chama /messages/send-media-ref com o path. O binário
   * nunca passa pelo corpo HTTP da API (era o motivo do limite de 60mb).
   */
  @Post('upload-url')
  @Roles(UserRole.OPERADOR)
  async createUploadUrl(@Body() body: unknown, @Req() req: Record<string, unknown>) {
    const user = req.user as AuthUser;
    const { lead_id, filename, mimetype } = uploadUrlSchema.parse(body);

    // Lead precisa existir no tenant do usuário — impede upload órfão/cross-tenant.
    const lead = await this.prisma.lead.findFirst({
      where: { id: lead_id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead nao encontrado');

    const path = `uploads/${lead_id}/${uuid()}.${safeExt(filename)}`;
    const signed = await this.media.createSignedUploadUrl(path);
    return { ...signed, mimetype };
  }
}
