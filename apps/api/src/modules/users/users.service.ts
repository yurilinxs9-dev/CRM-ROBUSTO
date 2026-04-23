import { Injectable, BadRequestException, ForbiddenException, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import * as bcrypt from 'bcryptjs';
import { randomUUID } from 'crypto';

const TEAM_SELECT = {
  id: true,
  nome: true,
  email: true,
  role: true,
  ativo: true,
  avatar_url: true,
  titulo: true,
  especialidade: true,
  created_at: true,
} as const;

@Injectable()
export class UsersService {
  constructor(
    private prisma: PrismaService,
    private media: MediaService,
  ) {}

  findAll(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId },
      select: TEAM_SELECT,
      orderBy: { nome: 'asc' },
    });
  }

  async createTeamMember(
    caller: AuthUser,
    dto: { nome: string; email: string; senha: string; role: string },
  ) {
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível criar SUPER_ADMIN');
    }
    const validRoles = [UserRole.GERENTE, UserRole.OPERADOR, UserRole.VISUALIZADOR];
    if (!validRoles.includes(dto.role as UserRole)) {
      throw new BadRequestException('Role inválida');
    }
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('Email já cadastrado');

    const senha_hash = await bcrypt.hash(dto.senha, 12);
    const userId = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "User" (id, nome, email, senha_hash, role, ativo, tenant_id, created_at, updated_at)
      VALUES (${userId}, ${dto.nome}, ${dto.email}, ${senha_hash}, ${dto.role}::"UserRole", true, ${caller.tenantId}, NOW(), NOW())
    `;
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: TEAM_SELECT });
  }

  async updateTeamMember(
    caller: AuthUser,
    targetId: string,
    dto: { role?: string; titulo?: string | null; especialidade?: string | null; ativo?: boolean },
  ) {
    const target = await this.prisma.user.findUnique({
      where: { id: targetId },
      select: { id: true, role: true, tenant_id: true },
    });
    if (!target || target.tenant_id !== caller.tenantId) throw new NotFoundException();
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível editar SUPER_ADMIN');
    }
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível promover a SUPER_ADMIN');
    }

    const data: Record<string, unknown> = {};
    if (dto.role !== undefined) data.role = dto.role;
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.especialidade !== undefined) data.especialidade = dto.especialidade;
    if (dto.ativo !== undefined) data.ativo = dto.ativo;

    return this.prisma.user.update({
      where: { id: targetId },
      data,
      select: TEAM_SELECT,
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
      select: { id: true, nome: true, email: true, role: true },
      orderBy: { nome: 'asc' },
    });
  }
}
