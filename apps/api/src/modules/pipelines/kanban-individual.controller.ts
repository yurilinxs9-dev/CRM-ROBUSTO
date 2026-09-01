import { Body, Controller, Post, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { KanbanIndividualService } from './kanban-individual.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { RolesGuard } from '../../common/guards/roles.guard';
import { Roles } from '../../common/decorators/roles.decorator';
import { UserRole } from '../../common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

const toggleSchema = z.object({ enabled: z.boolean() });

/**
 * Rota fina: toda a travessia (clonar colunas, remapear leads, gravar a flag)
 * mora no service, que revalida o papel por conta propria. O @Roles aqui e a
 * primeira barreira — o RolesGuard e hierarquico, entao GERENTE ja deixa passar
 * SUPER_ADMIN, os mesmos dois papeis que o service aceita.
 */
@Controller('kanban-individual')
@UseGuards(JwtAuthGuard, RolesGuard)
export class KanbanIndividualController {
  constructor(private readonly kanbanIndividual: KanbanIndividualService) {}

  @Post()
  @Roles(UserRole.GERENTE)
  async toggle(@Req() req: Record<string, unknown>, @Body() body: unknown) {
    const { enabled } = toggleSchema.parse(body);
    const user = req.user as AuthUser;

    if (enabled) {
      await this.kanbanIndividual.enable(user);
    } else {
      await this.kanbanIndividual.disable(user);
    }

    return { success: true, kanban_individual: enabled };
  }
}
