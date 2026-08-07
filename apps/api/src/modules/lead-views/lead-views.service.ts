import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

/** Critérios que o painel sabe serializar. O resto é descartado. */
const CHAVES_PERMITIDAS = [
  'tags',
  'created_from',
  'created_to',
  'valor_min',
  'valor_max',
  'tarefa',
  'origem',
  'followup_from',
  'followup_to',
  'temperatura',
  'responsavel_id',
] as const;

@Injectable()
export class LeadViewsService {
  constructor(private prisma: PrismaService) {}

  /**
   * As views que este usuário enxerga: as dele mais as compartilhadas do tenant
   * (`user_id` null). View de OUTRO usuário nunca aparece — é configuração de
   * tela pessoal, e listar a de todo mundo transformaria a barra lateral num
   * amontoado sem dono.
   */
  findAll(user: AuthUser) {
    return this.prisma.leadView.findMany({
      where: {
        tenant_id: user.tenantId,
        OR: [{ user_id: user.id }, { user_id: null }],
      },
      orderBy: [{ user_id: 'asc' }, { nome: 'asc' }],
    });
  }

  /**
   * Só deixa passar as chaves que o painel conhece, e só com valor de tipo
   * esperado. O corpo vem do cliente e vai direto para uma coluna Json: sem
   * este recorte, qualquer coisa entraria e voltaria depois como "filtro",
   * indo parar na query string da listagem.
   */
  private sanitizarFiltros(bruto: unknown): Prisma.InputJsonObject {
    if (!bruto || typeof bruto !== 'object' || Array.isArray(bruto)) return {};
    const entrada = bruto as Record<string, unknown>;
    const limpo: Record<string, string | string[]> = {};

    for (const chave of CHAVES_PERMITIDAS) {
      const valor = entrada[chave];
      if (typeof valor === 'string' && valor.trim()) {
        limpo[chave] = valor.trim();
      } else if (Array.isArray(valor)) {
        const lista = valor.filter((v): v is string => typeof v === 'string' && !!v.trim());
        if (lista.length > 0) limpo[chave] = lista;
      }
    }
    return limpo as Prisma.InputJsonObject;
  }

  async create(user: AuthUser, body: { nome?: string; filtros?: unknown; compartilhada?: boolean }) {
    const nome = (body?.nome ?? '').trim();
    if (!nome) throw new BadRequestException('Nome do filtro e obrigatorio');

    return this.prisma.leadView.create({
      data: {
        nome,
        filtros: this.sanitizarFiltros(body?.filtros),
        // Compartilhada = sem dono. Só quem pode administrar o tenant deveria
        // criar assim; o guard de role fica no controller.
        user_id: body?.compartilhada ? null : user.id,
        tenant_id: user.tenantId,
      },
    });
  }

  async update(
    user: AuthUser,
    id: string,
    body: { nome?: string; filtros?: unknown },
  ) {
    const view = await this.buscarEditavel(user, id);

    const data: Prisma.LeadViewUpdateInput = {};
    if (body?.nome !== undefined) {
      const nome = (body.nome ?? '').trim();
      if (!nome) throw new BadRequestException('Nome do filtro e obrigatorio');
      data.nome = nome;
    }
    if (body?.filtros !== undefined) data.filtros = this.sanitizarFiltros(body.filtros);

    return this.prisma.leadView.update({ where: { id: view.id }, data });
  }

  async remove(user: AuthUser, id: string) {
    const view = await this.buscarEditavel(user, id);
    await this.prisma.leadView.delete({ where: { id: view.id } });
    return { id: view.id };
  }

  /**
   * Localiza a view garantindo tenant E autoria antes de qualquer escrita.
   *
   * O filtro por `tenant_id` isolado não basta: sem o recorte por dono, um
   * operador editaria a view pessoal de um colega do mesmo workspace. View
   * compartilhada (`user_id` null) é editável por quem estiver no tenant — é
   * dela a função de ser de todos.
   */
  private async buscarEditavel(user: AuthUser, id: string) {
    const view = await this.prisma.leadView.findFirst({
      where: {
        id,
        tenant_id: user.tenantId,
        OR: [{ user_id: user.id }, { user_id: null }],
      },
      select: { id: true },
    });
    if (!view) throw new NotFoundException('Filtro nao encontrado');
    return view;
  }
}
