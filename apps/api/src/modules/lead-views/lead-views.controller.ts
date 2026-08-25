import { Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { LeadViewsService } from './lead-views.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import type { AuthUser } from '../../common/types/auth-user';

interface SalvarViewBody {
  nome?: string;
  filtros?: unknown;
  compartilhada?: boolean;
  // Config de tela; chega crua e o service sanitiza.
  tipo_padrao?: unknown;
  sort?: unknown;
  colunas?: unknown;
  card_fields?: unknown;
}

@Controller('lead-views')
@UseGuards(JwtAuthGuard)
export class LeadViewsController {
  constructor(private service: LeadViewsService) {}

  @Get()
  findAll(@Req() req: Record<string, unknown>) {
    return this.service.findAll(req.user as AuthUser);
  }

  @Post()
  create(@Req() req: Record<string, unknown>, @Body() body: SalvarViewBody) {
    return this.service.create(req.user as AuthUser, body);
  }

  @Patch(':id')
  update(
    @Req() req: Record<string, unknown>,
    @Param('id') id: string,
    @Body() body: SalvarViewBody,
  ) {
    return this.service.update(req.user as AuthUser, id, body);
  }

  @Delete(':id')
  remove(@Req() req: Record<string, unknown>, @Param('id') id: string) {
    return this.service.remove(req.user as AuthUser, id);
  }
}
