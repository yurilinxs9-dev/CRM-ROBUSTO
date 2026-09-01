import { Injectable, BadRequestException, ForbiddenException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MediaService } from '../media/media.service';
import { SectorsService } from '../sectors/sectors.service';
import {
  KanbanIndividualService,
  TX_OPTS,
  temBoardProprio,
} from '../pipelines/kanban-individual.service';
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
  sector_id: true,
  sector: { select: { id: true, name: true } },
} as const;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    private prisma: PrismaService,
    private media: MediaService,
    private sectors: SectorsService,
    private kanbanIndividual: KanbanIndividualService,
  ) {}

  /**
   * Kanban individual: membro que entra na equipe DEPOIS do toggle ligado
   * precisa ganhar a copia das colunas base agora — `enable()` clonou uma vez
   * so, para quem ja estava no tenant. Sem isto o Kanban do contratado novo
   * abre em branco, sem erro nenhum, ate alguem desligar e religar a feature.
   *
   * Idempotente (quem ja tem colunas nao ganha um segundo conjunto) e
   * ACESSORIO: o usuario ja esta gravado quando isto roda, entao uma falha aqui
   * vira log — nunca um 500 numa criacao que deu certo. Papel sem board
   * (VISUALIZADOR) le a base e nao clona nada.
   */
  private async garantirBoardDoMembro(
    tenantId: string,
    userId: string,
    role: string,
  ): Promise<void> {
    try {
      if (!temBoardProprio(role)) return;
      if (!(await this.kanbanIndividual.isOn(tenantId))) return;
      const jaTem = await this.prisma.stage.count({
        where: { tenant_id: tenantId, user_id: userId },
      });
      if (jaTem > 0) return;
      await this.prisma.$transaction(
        (tx) => this.kanbanIndividual.cloneBaseForUser(tx, tenantId, userId),
        TX_OPTS,
      );
    } catch (err) {
      this.logger.error(
        `kanban individual: falha ao clonar o board do membro ${userId} (tenant ${tenantId}): ${String(err)}`,
      );
    }
  }

  findAll(user: AuthUser) {
    return this.prisma.user.findMany({
      where: { tenant_id: user.tenantId },
      select: TEAM_SELECT,
      orderBy: { nome: 'asc' },
    });
  }

  async createTeamMember(
    caller: AuthUser,
    dto: { nome: string; email: string; senha: string; role: string; sector_id?: string | null },
  ) {
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível criar SUPER_ADMIN');
    }
    const validRoles = [UserRole.GERENTE, UserRole.OPERADOR, UserRole.VISUALIZADOR];
    if (!validRoles.includes(dto.role as UserRole)) {
      throw new BadRequestException('Role inválida');
    }
    // Setor é opcional; quando informado, valida que existe, é do tenant e está ativo.
    const sectorId = dto.sector_id
      ? await this.sectors.assertActiveForTenant(caller.tenantId, dto.sector_id)
      : null;
    const exists = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (exists) throw new ConflictException('Email já cadastrado');

    const senha_hash = await bcrypt.hash(dto.senha, 12);
    const userId = randomUUID();
    await this.prisma.$executeRaw`
      INSERT INTO "User" (id, nome, email, senha_hash, role, ativo, tenant_id, sector_id, created_at, updated_at)
      VALUES (${userId}, ${dto.nome}, ${dto.email}, ${senha_hash}, ${dto.role}::"UserRole", true, ${caller.tenantId}, ${sectorId}, NOW(), NOW())
    `;
    await this.garantirBoardDoMembro(caller.tenantId, userId, dto.role);
    return this.prisma.user.findUniqueOrThrow({ where: { id: userId }, select: TEAM_SELECT });
  }

  async linkTeamMember(caller: AuthUser, dto: { email: string; role: string; sector_id?: string | null }) {
    if (dto.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível vincular como SUPER_ADMIN');
    }
    const target = await this.prisma.user.findUnique({ where: { email: dto.email } });
    if (!target) throw new NotFoundException('Usuário não encontrado');
    if (target.role === UserRole.SUPER_ADMIN) {
      throw new ForbiddenException('Não é possível vincular SUPER_ADMIN');
    }
    if (target.tenant_id === caller.tenantId) {
      throw new ConflictException('Usuário já faz parte da equipe');
    }
    const sectorId = dto.sector_id
      ? await this.sectors.assertActiveForTenant(caller.tenantId, dto.sector_id)
      : null;
    const vinculado = await this.prisma.user.update({
      where: { id: target.id },
      data: { tenant_id: caller.tenantId, role: dto.role as UserRole, sector_id: sectorId },
      select: TEAM_SELECT,
    });
    // Vincular e a outra porta de entrada da equipe: o efeito no board e o
    // mesmo de criar do zero.
    await this.garantirBoardDoMembro(caller.tenantId, target.id, dto.role);
    return vinculado;
  }

  async updateTeamMember(
    caller: AuthUser,
    targetId: string,
    dto: { role?: string; titulo?: string | null; especialidade?: string | null; ativo?: boolean; sector_id?: string | null },
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
    if (dto.sector_id !== undefined) {
      // null remove o membro do setor; string valida contra o tenant.
      data.sector_id = dto.sector_id
        ? await this.sectors.assertActiveForTenant(caller.tenantId, dto.sector_id)
        : null;
    }

    return this.prisma.user.update({
      where: { id: targetId },
      data,
      select: TEAM_SELECT,
    });
  }

  async changePassword(user: AuthUser, dto: { currentPassword: string; newPassword: string }) {
    const row = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { senha_hash: true },
    });
    if (!row) throw new BadRequestException('Usuário não encontrado');
    const ok = await bcrypt.compare(dto.currentPassword, row.senha_hash);
    if (!ok) throw new BadRequestException('Senha atual incorreta');
    const senha_hash = await bcrypt.hash(dto.newPassword, 12);
    await this.prisma.user.update({ where: { id: user.id }, data: { senha_hash } });
    return { ok: true };
  }

  async updateProfile(
    user: AuthUser,
    dto: { nome?: string; titulo?: string | null; especialidade?: string | null; focus_mode?: boolean },
  ) {
    const data: Record<string, unknown> = {};
    if (dto.nome !== undefined) data.nome = dto.nome;
    if (dto.titulo !== undefined) data.titulo = dto.titulo;
    if (dto.especialidade !== undefined) data.especialidade = dto.especialidade;
    if (dto.focus_mode !== undefined) data.focus_mode = dto.focus_mode;
    return this.prisma.user.update({
      where: { id: user.id },
      data,
      select: { id: true, nome: true, email: true, role: true, avatar_url: true, titulo: true, especialidade: true, focus_mode: true },
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
