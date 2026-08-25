import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import { NATIVE_FIELDS } from '../leads/field-schema';

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

/** Campos por onde a listagem sabe ordenar. Ordenar por custom não é suportado. */
export const SORTABLE_FIELDS = [
  'nome',
  'created_at',
  'ultima_interacao',
  'valor_estimado',
  'temperatura',
  'proximo_followup',
] as const;

/**
 * Colunas de relação/derivadas que a tabela sabe renderizar além dos campos de ficha.
 *
 * Precisa espelhar o catálogo `PSEUDO_CAMPOS` do front (`/leads`): chave que o
 * menu de colunas oferece mas que não estiver aqui é descartada no save, e o
 * usuário vê a coluna sumir depois do toast de sucesso. As três últimas são
 * derivadas que o `mapRow` da listagem calcula — só de leitura, e por isso NÃO
 * entram em `SORTABLE_FIELDS`.
 */
const PSEUDO_COLUNAS = [
  'estagio',
  'responsavel',
  'tags',
  'created_at',
  'ultima_interacao',
  'telefone',
  'ultimo_mensagem',
  'mensagens_nao_lidas',
  'pending_tasks_count',
] as const;

/** Quem pode mexer em view sem dono — ela é da equipe inteira. */
const GESTORES: readonly string[] = ['GERENTE', 'SUPER_ADMIN'];

/** Largura de coluna aceita na tabela; fora disso a UI quebra o layout. */
const WIDTH_MIN = 60;
const WIDTH_MAX = 640;

/**
 * Teto de entradas por lista. Nenhuma tela mostra 100 colunas — o número existe
 * para que a coluna Json não vire depósito de milhares de chaves válidas.
 */
const MAX_ITENS = 100;

/** Parte do corpo que descreve a configuração de tela. Tudo `unknown`: vem do cliente. */
interface ConfigBody {
  tipo_padrao?: unknown;
  sort?: unknown;
  colunas?: unknown;
  card_fields?: unknown;
}

interface ConfigSanitizada {
  tipo_padrao: string;
  sort: Prisma.InputJsonObject;
  colunas: Prisma.InputJsonArray;
  card_fields: Prisma.InputJsonArray;
}

type SalvarBody = { nome?: string; filtros?: unknown; compartilhada?: boolean } & ConfigBody;

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

  /**
   * Chaves que podem virar coluna ou campo de card: campo nativo do lead, campo
   * custom ATIVO do próprio tenant, ou pseudo-coluna de relação. Chave de outro
   * tenant não entra — a config vira leitura de campo na tela depois.
   */
  private async chavesValidas(tenantId: string): Promise<Set<string>> {
    const defs = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, escopo: 'LEAD', active: true },
      select: { key: true },
    });
    return new Set<string>([
      ...NATIVE_FIELDS.LEAD.map((f) => f.native_key),
      ...defs.map((d) => d.key),
      ...PSEUDO_COLUNAS,
    ]);
  }

  /**
   * Recorta a config de tela igual aos filtros: só tipo conhecido, só chave que
   * existe hoje no tenant, largura dentro do que a tabela aguenta. O que sobra é
   * exatamente o que a UI consegue renderizar sem checagem extra na leitura.
   *
   * As listas ainda saem sem repetição (chave repetida viraria key duplicada no
   * React) e cortadas em MAX_ITENS. Tudo em silêncio, como o resto do recorte.
   */
  private sanitizarConfig(body: ConfigBody, validas: Set<string>): ConfigSanitizada {
    const tipo_padrao = body.tipo_padrao === 'lista' ? 'lista' : 'kanban';

    let sort: Prisma.InputJsonObject = {};
    if (body.sort && typeof body.sort === 'object' && !Array.isArray(body.sort)) {
      const s = body.sort as Record<string, unknown>;
      if (
        typeof s.campo === 'string' &&
        (SORTABLE_FIELDS as readonly string[]).includes(s.campo) &&
        (s.dir === 'asc' || s.dir === 'desc')
      ) {
        sort = { campo: s.campo, dir: s.dir };
      }
    }

    const colunas: Array<{ key: string; width?: number }> = [];
    const vistasColunas = new Set<string>();
    if (Array.isArray(body.colunas)) {
      for (const c of body.colunas) {
        if (colunas.length >= MAX_ITENS) break;
        if (!c || typeof c !== 'object' || Array.isArray(c)) continue;
        const col = c as Record<string, unknown>;
        if (typeof col.key !== 'string' || !validas.has(col.key)) continue;
        if (vistasColunas.has(col.key)) continue; // repetida: vale a primeira
        vistasColunas.add(col.key);
        const width =
          typeof col.width === 'number' && Number.isFinite(col.width)
            ? Math.min(WIDTH_MAX, Math.max(WIDTH_MIN, Math.round(col.width)))
            : undefined;
        colunas.push(width !== undefined ? { key: col.key, width } : { key: col.key });
      }
    }

    const card_fields: string[] = [];
    const vistosCards = new Set<string>();
    if (Array.isArray(body.card_fields)) {
      for (const v of body.card_fields) {
        if (card_fields.length >= MAX_ITENS) break;
        if (typeof v !== 'string' || !validas.has(v) || vistosCards.has(v)) continue;
        vistosCards.add(v);
        card_fields.push(v);
      }
    }

    return {
      tipo_padrao,
      sort,
      colunas: colunas as unknown as Prisma.InputJsonArray,
      card_fields: card_fields as unknown as Prisma.InputJsonArray,
    };
  }

  /**
   * View compartilhada não tem dono, então a checagem de autoria não protege
   * nada nela: sem isto, qualquer operador reconfiguraria a tela do time todo.
   */
  private exigirGestor(user: AuthUser) {
    if (!GESTORES.includes(user.role)) {
      throw new ForbiddenException('Apenas gestores podem gerenciar views compartilhadas');
    }
  }

  async create(user: AuthUser, body: SalvarBody) {
    const nome = (body?.nome ?? '').trim();
    if (!nome) throw new BadRequestException('Nome do filtro e obrigatorio');
    if (body?.compartilhada) this.exigirGestor(user);

    const config = this.sanitizarConfig(body ?? {}, await this.chavesValidas(user.tenantId));

    return this.prisma.leadView.create({
      data: {
        nome,
        filtros: this.sanitizarFiltros(body?.filtros),
        ...config,
        // Compartilhada = sem dono.
        user_id: body?.compartilhada ? null : user.id,
        tenant_id: user.tenantId,
      },
    });
  }

  async update(user: AuthUser, id: string, body: SalvarBody) {
    const view = await this.buscarEditavel(user, id);
    if (view.user_id === null) this.exigirGestor(user);

    const data: Prisma.LeadViewUpdateInput = {};
    if (body?.nome !== undefined) {
      const nome = (body.nome ?? '').trim();
      if (!nome) throw new BadRequestException('Nome do filtro e obrigatorio');
      data.nome = nome;
    }
    if (body?.filtros !== undefined) data.filtros = this.sanitizarFiltros(body.filtros);

    // Config é PATCH de verdade: só encosta na coluna que veio no corpo, senão
    // salvar o nome zeraria as colunas que o usuário já tinha arrumado.
    const temConfig =
      body?.tipo_padrao !== undefined ||
      body?.sort !== undefined ||
      body?.colunas !== undefined ||
      body?.card_fields !== undefined;

    if (temConfig) {
      const config = this.sanitizarConfig(body, await this.chavesValidas(user.tenantId));
      if (body.tipo_padrao !== undefined) data.tipo_padrao = config.tipo_padrao;
      if (body.sort !== undefined) data.sort = config.sort;
      if (body.colunas !== undefined) data.colunas = config.colunas;
      if (body.card_fields !== undefined) data.card_fields = config.card_fields;
    }

    return this.prisma.leadView.update({ where: { id: view.id }, data });
  }

  async remove(user: AuthUser, id: string) {
    const view = await this.buscarEditavel(user, id);
    if (view.user_id === null) this.exigirGestor(user);
    await this.prisma.leadView.delete({ where: { id: view.id } });
    return { id: view.id };
  }

  /**
   * Localiza a view garantindo tenant E autoria antes de qualquer escrita.
   *
   * O filtro por `tenant_id` isolado não basta: sem o recorte por dono, um
   * operador editaria a view pessoal de um colega do mesmo workspace. View
   * compartilhada (`user_id` null) é visível para todo o tenant, mas só gestor
   * escreve nela — por isso `user_id` volta no select: quem chama decide.
   */
  private async buscarEditavel(user: AuthUser, id: string) {
    const view = await this.prisma.leadView.findFirst({
      where: {
        id,
        tenant_id: user.tenantId,
        OR: [{ user_id: user.id }, { user_id: null }],
      },
      select: { id: true, user_id: true },
    });
    if (!view) throw new NotFoundException('Filtro nao encontrado');
    return view;
  }
}
