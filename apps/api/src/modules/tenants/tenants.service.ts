import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  updateSettings(caller: AuthUser, dto: { pool_enabled?: boolean; prefix_enabled?: boolean }) {
    const data: Record<string, unknown> = {};
    if (dto.pool_enabled !== undefined) data.pool_enabled = dto.pool_enabled;
    if (dto.prefix_enabled !== undefined) data.prefix_enabled = dto.prefix_enabled;
    return this.prisma.tenant.update({
      where: { id: caller.tenantId },
      data,
      select: { id: true, nome: true, pool_enabled: true, prefix_enabled: true },
    });
  }
}
