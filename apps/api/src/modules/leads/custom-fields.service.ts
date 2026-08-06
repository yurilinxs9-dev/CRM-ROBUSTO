import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';
import {
  FIELD_SCOPES,
  FIELD_TYPES,
  NATIVE_FIELDS,
  OPTION_TYPES,
  coerceValue,
  findNative,
  FieldValueError,
  type FieldScope,
} from './field-schema';

/** Nome do grupo criado no bootstrap. Não pode ser apagado (is_system). */
const DEFAULT_GROUP_NAME = 'Principal';

/**
 * Deslocamento aplicado à `ordem` de campos que já existiam quando o bootstrap
 * roda, pra eles caírem DEPOIS dos nativos em vez de intercalar (nativos ocupam
 * 0..N e os antigos costumam estar todos em 0).
 */
const LEGACY_ORDER_OFFSET = 100;

const escopoSchema = z.enum(FIELD_SCOPES);

const createSchema = z.object({
  nome: z.string().min(1).max(60),
  tipo: z.enum(FIELD_TYPES),
  options: z.array(z.string().min(1).max(60)).max(50).optional(),
  ordem: z.number().int().min(0).optional(),
  escopo: escopoSchema.default('LEAD'),
  group_id: z.string().uuid().optional(),
});

const updateSchema = z.object({
  nome: z.string().min(1).max(60).optional(),
  options: z.array(z.string().min(1).max(60)).max(50).optional(),
  ordem: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
  visible: z.boolean().optional(),
  api_only: z.boolean().optional(),
  group_id: z.string().uuid().optional(),
});

const reorderSchema = z
  .array(
    z.object({
      id: z.string().uuid(),
      group_id: z.string().uuid(),
      ordem: z.number().int().min(0),
    }),
  )
  .min(1)
  .max(200);

const groupCreateSchema = z.object({
  nome: z.string().min(1).max(40),
  escopo: escopoSchema.default('LEAD'),
  ordem: z.number().int().min(0).optional(),
});

const groupUpdateSchema = z.object({
  nome: z.string().min(1).max(40).optional(),
  ordem: z.number().int().min(0).optional(),
});

/** Slug estável a partir do nome: "Data de nascimento" → "data_de_nascimento". */
function slugify(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/**
 * Definições de campos por tenant, nos três escopos (lead, contato, empresa) —
 * paridade com o editor de campos do Kommo.
 *
 * Campos NATIVOS e customizados moram na mesma tabela e na mesma lista
 * ordenável. O que os separa é `native_key`: preenchida = o valor vive numa
 * COLUNA do registro; nula = vive no Json `dados_custom`.
 *
 * Ver docs/plans/2026-08-05-campos-personalizados-kommo.md.
 */
@Injectable()
export class CustomFieldsService {
  constructor(private prisma: PrismaService) {}

  // -------------------------------------------------------------------------
  // Bootstrap
  // -------------------------------------------------------------------------

  /**
   * Materializa grupo de sistema + campos nativos na primeira vez que o tenant
   * abre a ficha. É assim que "cada empresa vem crua": nenhum campo de NEGÓCIO
   * é criado aqui, só a estrutura mínima sem a qual a tela não desenha.
   *
   * Idempotente por construção — todo write é `skipDuplicates` ou filtrado por
   * `group_id: null`, então duas requisições simultâneas não duplicam nada.
   */
  private async ensureBootstrap(tenantId: string): Promise<void> {
    const jaTem = await this.prisma.customFieldGroup.count({ where: { tenant_id: tenantId } });
    if (jaTem > 0) return;

    await this.prisma.customFieldGroup.createMany({
      data: FIELD_SCOPES.map((escopo) => ({
        tenant_id: tenantId,
        escopo,
        nome: DEFAULT_GROUP_NAME,
        ordem: 0,
        is_system: true,
      })),
      skipDuplicates: true,
    });

    const grupos = await this.prisma.customFieldGroup.findMany({
      where: { tenant_id: tenantId, is_system: true },
      select: { id: true, escopo: true },
    });
    const grupoPorEscopo = new Map<FieldScope, string>(
      grupos.map((g) => [g.escopo as FieldScope, g.id]),
    );

    // Chaves já ocupadas por campos customizados do tenant. Se alguém criou um
    // campo "Nome" (key `nome`) antes desta feature, o nativo homônimo entra com
    // uma key distinta: `native_key` é que aponta pra coluna, então os dois
    // convivem e nenhum valor se perde.
    const existentes = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, native_key: null },
      select: { escopo: true, key: true },
    });
    const ocupadas = new Set(existentes.map((d) => `${d.escopo}:${d.key}`));

    const novos = FIELD_SCOPES.flatMap((escopo) =>
      NATIVE_FIELDS[escopo].map((spec) => ({
        tenant_id: tenantId,
        nome: spec.nome,
        key: ocupadas.has(`${escopo}:${spec.native_key}`)
          ? `${spec.native_key}__nativo`
          : spec.native_key,
        tipo: spec.tipo,
        options: spec.options ?? undefined,
        ordem: spec.ordem,
        escopo,
        group_id: grupoPorEscopo.get(escopo) ?? null,
        native_key: spec.native_key,
        api_only: spec.api_only,
        visible: true,
        active: true,
      })),
    );
    await this.prisma.customFieldDef.createMany({ data: novos, skipDuplicates: true });

    // Adota os campos que já existiam (group_id nulo) no grupo do seu escopo,
    // empurrando-os pra depois dos nativos.
    for (const escopo of FIELD_SCOPES) {
      const gid = grupoPorEscopo.get(escopo);
      if (!gid) continue;
      await this.prisma.customFieldDef.updateMany({
        where: { tenant_id: tenantId, escopo, group_id: null },
        data: { group_id: gid, ordem: { increment: LEGACY_ORDER_OFFSET } },
      });
    }
  }

  // -------------------------------------------------------------------------
  // Leitura
  // -------------------------------------------------------------------------

  /**
   * Compatibilidade com o cliente antigo: devolve só os campos CUSTOMIZADOS do
   * lead, que é exatamente o que esta rota retornava antes dos escopos. A UI
   * nova usa `schema()`.
   */
  async list(user: AuthUser) {
    await this.ensureBootstrap(user.tenantId);
    return this.prisma.customFieldDef.findMany({
      where: { tenant_id: user.tenantId, active: true, escopo: 'LEAD', native_key: null },
      orderBy: [{ ordem: 'asc' }, { created_at: 'asc' }],
    });
  }

  /** Schema completo: grupos + campos dos três escopos, nativos incluídos. */
  async schema(user: AuthUser) {
    await this.ensureBootstrap(user.tenantId);
    const [groups, fields] = await Promise.all([
      this.prisma.customFieldGroup.findMany({
        where: { tenant_id: user.tenantId },
        orderBy: [{ escopo: 'asc' }, { ordem: 'asc' }, { created_at: 'asc' }],
      }),
      this.prisma.customFieldDef.findMany({
        where: { tenant_id: user.tenantId, active: true },
        orderBy: [{ escopo: 'asc' }, { ordem: 'asc' }, { created_at: 'asc' }],
      }),
    ]);
    // `obrigatorio` é propriedade do CÓDIGO, não configuração do tenant — vem
    // de NATIVE_FIELDS e é derivado na leitura, sem coluna no banco. Assim a
    // regra vive num lugar só e não pode divergir por tenant.
    const comObrigatorio = fields.map((f) => ({
      ...f,
      obrigatorio: f.native_key
        ? (findNative(f.escopo as FieldScope, f.native_key)?.obrigatorio ?? false)
        : false,
    }));
    return { groups, fields: comObrigatorio };
  }

  // -------------------------------------------------------------------------
  // Campos
  // -------------------------------------------------------------------------

  /** Resolve o grupo de destino, garantindo tenant e escopo coerentes. */
  private async resolveGroupId(
    groupId: string | undefined,
    escopo: FieldScope,
    tenantId: string,
  ): Promise<string> {
    if (groupId) {
      const grupo = await this.prisma.customFieldGroup.findFirst({
        where: { id: groupId, tenant_id: tenantId },
      });
      if (!grupo) throw new NotFoundException('Grupo não encontrado');
      if (grupo.escopo !== escopo) {
        throw new BadRequestException('Grupo pertence a outro escopo');
      }
      return grupo.id;
    }
    const sistema = await this.prisma.customFieldGroup.findFirst({
      where: { tenant_id: tenantId, escopo, is_system: true },
    });
    if (!sistema) throw new NotFoundException('Grupo padrão não encontrado');
    return sistema.id;
  }

  async create(body: unknown, user: AuthUser) {
    const data = createSchema.parse(body);
    await this.ensureBootstrap(user.tenantId);

    if (OPTION_TYPES.includes(data.tipo) && !data.options?.length) {
      throw new BadRequestException('Campo de seleção precisa de opções');
    }
    const key = slugify(data.nome);
    if (!key) throw new BadRequestException('Nome inválido');

    const groupId = await this.resolveGroupId(data.group_id, data.escopo, user.tenantId);

    const exists = await this.prisma.customFieldDef.findUnique({
      where: { tenant_id_escopo_key: { tenant_id: user.tenantId, escopo: data.escopo, key } },
    });
    if (exists) {
      if (exists.native_key) throw new ConflictException('Já existe um campo nativo com esse nome');
      // Reativar em vez de duplicar: histórico nos leads continua válido.
      if (!exists.active) {
        return this.prisma.customFieldDef.update({
          where: { id: exists.id },
          data: {
            active: true,
            visible: true,
            nome: data.nome,
            options: data.options ?? undefined,
            group_id: groupId,
          },
        });
      }
      throw new ConflictException('Já existe um campo com esse nome');
    }

    return this.prisma.customFieldDef.create({
      data: {
        tenant_id: user.tenantId,
        nome: data.nome,
        key,
        tipo: data.tipo,
        options: data.options ?? undefined,
        ordem: data.ordem ?? 0,
        escopo: data.escopo,
        group_id: groupId,
      },
    });
  }

  async update(id: string, body: unknown, user: AuthUser) {
    const data = updateSchema.parse(body);
    const def = await this.prisma.customFieldDef.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!def) throw new NotFoundException('Campo não encontrado');

    if (def.native_key) {
      const spec = findNative(def.escopo as FieldScope, def.native_key);
      // Renomear e reordenar nativo é livre; desligar não.
      if (data.active === false) {
        throw new BadRequestException('Campo nativo não pode ser desativado');
      }
      if (data.visible === false && spec && !spec.removable) {
        throw new BadRequestException(
          `"${def.nome}" é usado pelo funcionamento do CRM e não pode ser escondido`,
        );
      }
      if (data.api_only !== undefined && data.api_only !== def.api_only) {
        throw new BadRequestException('Campo nativo não permite mudar "Apenas API"');
      }
    }

    if (data.group_id) {
      await this.resolveGroupId(data.group_id, def.escopo as FieldScope, user.tenantId);
    }
    if (data.options && !OPTION_TYPES.includes(def.tipo as (typeof OPTION_TYPES)[number])) {
      throw new BadRequestException('Este tipo de campo não usa opções');
    }

    return this.prisma.customFieldDef.update({ where: { id }, data });
  }

  /** Soft delete — valores já gravados nos leads são preservados. */
  async deactivate(id: string, user: AuthUser) {
    const def = await this.prisma.customFieldDef.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!def) throw new NotFoundException('Campo não encontrado');
    if (def.native_key) {
      throw new BadRequestException(
        'Campo nativo não pode ser removido — esconda com "visible" se não quiser vê-lo',
      );
    }
    return this.prisma.customFieldDef.update({
      where: { id },
      data: { active: false },
    });
  }

  /** Reordenação em lote (drag-and-drop). Tudo ou nada. */
  async reorder(body: unknown, user: AuthUser) {
    const itens = reorderSchema.parse(body);

    const ids = itens.map((i) => i.id);
    const defs = await this.prisma.customFieldDef.findMany({
      where: { id: { in: ids }, tenant_id: user.tenantId },
      select: { id: true, escopo: true },
    });
    if (defs.length !== new Set(ids).size) {
      throw new NotFoundException('Algum campo não pertence a este workspace');
    }
    const escopoPorId = new Map(defs.map((d) => [d.id, d.escopo as FieldScope]));

    const grupos = await this.prisma.customFieldGroup.findMany({
      where: { id: { in: [...new Set(itens.map((i) => i.group_id))] }, tenant_id: user.tenantId },
      select: { id: true, escopo: true },
    });
    const escopoPorGrupo = new Map(grupos.map((g) => [g.id, g.escopo as FieldScope]));

    for (const item of itens) {
      const escopoGrupo = escopoPorGrupo.get(item.group_id);
      if (!escopoGrupo) throw new NotFoundException('Grupo não encontrado');
      if (escopoGrupo !== escopoPorId.get(item.id)) {
        throw new BadRequestException('Campo não pode mudar de escopo');
      }
    }

    await this.prisma.$transaction(
      itens.map((i) =>
        this.prisma.customFieldDef.update({
          where: { id: i.id },
          data: { group_id: i.group_id, ordem: i.ordem },
        }),
      ),
    );
    return { ok: true, atualizados: itens.length };
  }

  // -------------------------------------------------------------------------
  // Grupos
  // -------------------------------------------------------------------------

  async createGroup(body: unknown, user: AuthUser) {
    const data = groupCreateSchema.parse(body);
    await this.ensureBootstrap(user.tenantId);
    const existe = await this.prisma.customFieldGroup.findFirst({
      where: { tenant_id: user.tenantId, escopo: data.escopo, nome: data.nome },
    });
    if (existe) throw new ConflictException('Já existe um grupo com esse nome neste escopo');
    return this.prisma.customFieldGroup.create({
      data: {
        tenant_id: user.tenantId,
        escopo: data.escopo,
        nome: data.nome,
        ordem: data.ordem ?? 0,
      },
    });
  }

  async updateGroup(id: string, body: unknown, user: AuthUser) {
    const data = groupUpdateSchema.parse(body);
    const grupo = await this.prisma.customFieldGroup.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!grupo) throw new NotFoundException('Grupo não encontrado');
    return this.prisma.customFieldGroup.update({ where: { id }, data });
  }

  /** Apaga o grupo e devolve os campos dele ao grupo de sistema do escopo. */
  async deleteGroup(id: string, user: AuthUser) {
    const grupo = await this.prisma.customFieldGroup.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!grupo) throw new NotFoundException('Grupo não encontrado');
    if (grupo.is_system) throw new BadRequestException('O grupo padrão não pode ser removido');

    const destino = await this.resolveGroupId(undefined, grupo.escopo as FieldScope, user.tenantId);
    await this.prisma.$transaction([
      this.prisma.customFieldDef.updateMany({
        where: { tenant_id: user.tenantId, group_id: id },
        data: { group_id: destino },
      }),
      this.prisma.customFieldGroup.delete({ where: { id } }),
    ]);
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Valores
  // -------------------------------------------------------------------------

  /**
   * Valida e COAGE um objeto de valores customizados contra as definições
   * ativas do escopo. Chave desconhecida é rejeitada; cada valor passa por
   * `coerceValue`, então o que sai daqui já está no tipo final.
   *
   * `fromPublicApi` libera a escrita em campos `api_only` — é justamente o que
   * dá sentido ao badge "Apenas API": bloqueado na UI, liberado na integração.
   */
  async validateValues(
    values: Record<string, unknown>,
    tenantId: string,
    escopo: FieldScope = 'LEAD',
    opts: { fromPublicApi?: boolean } = {},
  ): Promise<Record<string, unknown>> {
    const defs = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, active: true, escopo },
    });
    const byKey = new Map(defs.map((d) => [d.key, d]));

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const def = byKey.get(key);
      if (!def) throw new BadRequestException(`Campo customizado desconhecido: ${key}`);
      if (def.native_key) {
        // Nativo mora em coluna. Deixar entrar aqui criaria uma segunda cópia
        // no Json, que sombrearia a coluna na leitura.
        throw new BadRequestException(`"${def.nome}" é um campo nativo e não vai em dados_custom`);
      }
      if (def.api_only && !opts.fromPublicApi) {
        throw new BadRequestException(`"${def.nome}" só pode ser alterado pela API`);
      }
      try {
        out[key] = coerceValue(
          def.tipo as (typeof FIELD_TYPES)[number],
          value,
          (def.options as string[] | null) ?? undefined,
        );
      } catch (err) {
        if (err instanceof FieldValueError) {
          throw new BadRequestException(`"${def.nome}" ${err.message}`);
        }
        throw err;
      }
    }
    return out;
  }
}
