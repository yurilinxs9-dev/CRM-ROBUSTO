import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private media: MediaService,
  ) {}

  findAll(user: AuthUser) {
    // Tenant-scoped: prevents cross-tenant user enumeration.
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId },
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
        ativo: true,
        avatar_url: true,
        created_at: true,
      },
      orderBy: { nome: 'asc' },
    });
  }

  async updateProfile(user: AuthUser, dto: { nome?: string; titulo?: string | null; especialidade?: string | null }) {
    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.especialidade !== undefined) data.especialidade = dto.especialidade;
    return this.prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, nome: true, email: true, role: true, avatar_url: true, titulo: true, especialidade: true },
    });
  }

  async uploadAvatar(user: AuthUser, file: Express.Multer.File) {
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) {
      throw new BadRequestException('Apenas jpg, png ou webp são permitidos');
    }
    if (file.size > 5 * 1024 * 1024) {
      throw new BadRequestException('Tamanho máximo: 5MB');
    }
    const ext = file.mimetype.split('/')[1];
    const path = `avatars/${user.tenantId}/${user.id}.${ext}`;
    await this.media.upload(path, file.buffer, file.mimetype);
    const url = await this.media.getSignedUrl(path, 60 * 60 * 24 * 365);
    await this.prisma.user.update({ where: { id: user.id }, data: { avatar_url: url } });
    return { url };
  }

  findAllForTenant(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId, ativo: true },
      select: {
        id: true,
        nome: true,
        email: true,
        role: true,
      },
      orderBy: { nome: 'asc' },
    });
  }
}
