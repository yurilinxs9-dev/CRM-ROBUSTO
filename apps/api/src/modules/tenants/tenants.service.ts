import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

@Injectable()
export class TenantsService {
  constructor(private prisma: PrismaService) {}

  async updateSettings(
    caller: AuthUser,
    dto: {
      pool_enabled?: boolean;
      prefix_enabled?: boolean;
      round_robin_enabled?: boolean;
      share_history_enabled?: boolean;
      broadcast_window_start?: number;
      broadcast_window_end?: number;
      broadcast_window_days?: number[];
    },
  ) {
    const data: Record<string, unknown> = {};
    if (dto.pool_enabled !== undefined) data.pool_enabled = dto.pool_enabled;
    if (dto.prefix_enabled !== undefined) data.prefix_enabled = dto.prefix_enabled;
    if (dto.round_robin_enabled !== undefined) data.round_robin_enabled = dto.round_robin_enabled;
    if (dto.share_history_enabled !== undefined) data.share_history_enabled = dto.share_history_enabled;

    if (dto.broadcast_window_days !== undefined) {
      if (dto.broadcast_window_days.length === 0) {
        throw new BadRequestException('Escolha ao menos um dia da semana. Para parar um disparo, use Pausar.');
      }
      data.broadcast_window_days = [...new Set(dto.broadcast_window_days)].sort((a, b) => a - b);
    }

    if (dto.broadcast_window_start !== undefined || dto.broadcast_window_end !== undefined) {
      // Editar só um dos lados precisa ser conferido contra o valor JÁ gravado:
      // senão dá para inverter a janela em duas requisições individualmente
      // válidas, e o disparo morre em silêncio — o cron não tem tela de erro.
      let start = dto.broadcast_window_start;
      let end = dto.broadcast_window_end;
      if (start === undefined || end === undefined) {
        const atual = await this.prisma.tenant.findUnique({
          where: { id: caller.tenantId },
          select: { broadcast_window_start: true, broadcast_window_end: true },
        });
        start = start ?? atual?.broadcast_window_start ?? 9;
        end = end ?? atual?.broadcast_window_end ?? 18;
      }
      if (start >= end) {
        throw new BadRequestException('A hora de início precisa ser menor que a de fim (ex.: 9 e 18).');
      }
      if (dto.broadcast_window_start !== undefined) data.broadcast_window_start = dto.broadcast_window_start;
      if (dto.broadcast_window_end !== undefined) data.broadcast_window_end = dto.broadcast_window_end;
    }

    return this.prisma.tenant.update({
      where: { id: caller.tenantId },
      data,
      select: {
        id: true,
        nome: true,
        pool_enabled: true,
        prefix_enabled: true,
        round_robin_enabled: true,
        share_history_enabled: true,
        broadcast_window_start: true,
        broadcast_window_end: true,
        broadcast_window_days: true,
      },
    });
  }
}
