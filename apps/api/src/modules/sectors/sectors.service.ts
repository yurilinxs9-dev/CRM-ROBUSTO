import {
  Injectable,
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

const SECTOR_SELECT = {
  id: true,
  name: true,
  active: true,
  created_at: true,
  _count: { select: { users: true } },
} as const;

/**
 * F-01 — Setores por tenant. Cada colaborador pertence a exatamente um setor.
 * Soft delete (active=false): some do dropdown mas preserva o histórico dos
 * usuários vinculados.
 */
@Injectable()
export class SectorsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Lista setores do tenant. Por padrão só os ativos (para dropdowns). */
  list(user: AuthUser, includeInactive = false) {
    return this.prisma.sector.findMany({
      where: {
        tenant_id: user.tenantId,
        ...(includeInactive ? {} : { active: true }),
      },
      select: SECTOR_SELECT,
      orderBy: { name: 'asc' },
    });
  }

  async create(user: AuthUser, name: string) {
    const clean = name.trim();
    if (!clean) throw new BadRequestException('Nome do setor é obrigatório');
    const exists = await this.prisma.sector.findUnique({
      where: { tenant_id_name: { tenant_id: user.tenantId, name: clean } },
    });
    if (exists) {
      // Reativa um setor com mesmo nome que estava soft-deleted.
      if (!exists.active) {
        return this.prisma.sector.update({
          where: { id: exists.id },
          data: { active: true },
          select: SECTOR_SELECT,
        });
      }
      throw new ConflictException('Já existe um setor com esse nome');
    }
    return this.prisma.sector.create({
      data: { tenant_id: user.tenantId, name: clean },
      select: SECTOR_SELECT,
    });
  }

  async update(user: AuthUser, id: string, name: string) {
    const clean = name.trim();
    if (!clean) throw new BadRequestException('Nome do setor é obrigatório');
    await this.ensureOwned(user, id);
    const dup = await this.prisma.sector.findUnique({
      where: { tenant_id_name: { tenant_id: user.tenantId, name: clean } },
    });
    if (dup && dup.id !== id) {
      throw new ConflictException('Já existe um setor com esse nome');
    }
    return this.prisma.sector.update({
      where: { id },
      data: { name: clean },
      select: SECTOR_SELECT,
    });
  }

  /** Soft delete. Usuários vinculados permanecem (histórico preservado). */
  async softDelete(user: AuthUser, id: string) {
    await this.ensureOwned(user, id);
    await this.prisma.sector.update({ where: { id }, data: { active: false } });
    return { ok: true };
  }

  /**
   * Valida que um setor pertence ao tenant e está ativo. Usado pelo cadastro de
   * usuário (F-01). Retorna o id validado.
   */
  async assertActiveForTenant(tenantId: string, sectorId: string): Promise<string> {
    const sector = await this.prisma.sector.findFirst({
      where: { id: sectorId, tenant_id: tenantId, active: true },
      select: { id: true },
    });
    if (!sector) throw new BadRequestException('Setor inválido ou inativo');
    return sector.id;
  }

  private async ensureOwned(user: AuthUser, id: string) {
    const sector = await this.prisma.sector.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!sector) throw new NotFoundException('Setor não encontrado');
  }
}
