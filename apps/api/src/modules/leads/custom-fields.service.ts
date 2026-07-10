import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import type { AuthUser } from '../../common/types/auth-user';

const FIELD_TYPES = ['text', 'number', 'date', 'select', 'boolean'] as const;

const createSchema = z.object({
  nome: z.string().min(1).max(60),
  tipo: z.enum(FIELD_TYPES),
  options: z.array(z.string().min(1).max(60)).max(50).optional(),
  ordem: z.number().int().min(0).optional(),
});

const updateSchema = z.object({
  nome: z.string().min(1).max(60).optional(),
  options: z.array(z.string().min(1).max(60)).max(50).optional(),
  ordem: z.number().int().min(0).optional(),
  active: z.boolean().optional(),
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
 * Definições de campos customizados por tenant (padrão HubSpot/Pipedrive).
 * Valores ficam em Lead.dados_custom (Json { [key]: valor }).
 */
@Injectable()
export class CustomFieldsService {
  constructor(private prisma: PrismaService) {}

  list(user: AuthUser) {
    return this.prisma.customFieldDef.findMany({
      where: { tenant_id: user.tenantId, active: true },
      orderBy: [{ ordem: 'asc' }, { created_at: 'asc' }],
    });
  }

  async create(body: unknown, user: AuthUser) {
    const data = createSchema.parse(body);
    if (data.tipo === 'select' && !data.options?.length) {
      throw new BadRequestException('Campo select precisa de opções');
    }
    const key = slugify(data.nome);
    if (!key) throw new BadRequestException('Nome inválido');
    const exists = await this.prisma.customFieldDef.findUnique({
      where: { tenant_id_key: { tenant_id: user.tenantId, key } },
    });
    if (exists) {
      // Reativar em vez de duplicar: histórico nos leads continua válido.
      if (!exists.active) {
        return this.prisma.customFieldDef.update({
          where: { id: exists.id },
          data: { active: true, nome: data.nome, options: data.options ?? undefined },
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
      },
    });
  }

  async update(id: string, body: unknown, user: AuthUser) {
    const data = updateSchema.parse(body);
    const def = await this.prisma.customFieldDef.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!def) throw new NotFoundException('Campo não encontrado');
    return this.prisma.customFieldDef.update({ where: { id }, data });
  }

  /** Soft delete — valores já gravados nos leads são preservados. */
  async deactivate(id: string, user: AuthUser) {
    const def = await this.prisma.customFieldDef.findFirst({
      where: { id, tenant_id: user.tenantId },
    });
    if (!def) throw new NotFoundException('Campo não encontrado');
    return this.prisma.customFieldDef.update({
      where: { id },
      data: { active: false },
    });
  }

  /**
   * Valida um objeto de valores contra as definições ativas do tenant.
   * Chaves desconhecidas são rejeitadas; tipos são checados por campo.
   */
  async validateValues(values: Record<string, unknown>, tenantId: string) {
    const defs = await this.prisma.customFieldDef.findMany({
      where: { tenant_id: tenantId, active: true },
    });
    const byKey = new Map(defs.map((d) => [d.key, d]));
    for (const [key, value] of Object.entries(values)) {
      const def = byKey.get(key);
      if (!def) throw new BadRequestException(`Campo customizado desconhecido: ${key}`);
      if (value === null || value === undefined || value === '') continue;
      switch (def.tipo) {
        case 'number':
          if (typeof value !== 'number' || Number.isNaN(value)) {
            throw new BadRequestException(`"${def.nome}" precisa ser número`);
          }
          break;
        case 'boolean':
          if (typeof value !== 'boolean') {
            throw new BadRequestException(`"${def.nome}" precisa ser booleano`);
          }
          break;
        case 'date':
          if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
            throw new BadRequestException(`"${def.nome}" precisa ser data válida`);
          }
          break;
        case 'select': {
          const opts = (def.options as string[] | null) ?? [];
          if (typeof value !== 'string' || !opts.includes(value)) {
            throw new BadRequestException(`"${def.nome}" precisa ser uma das opções`);
          }
          break;
        }
        default:
          if (typeof value !== 'string') {
            throw new BadRequestException(`"${def.nome}" precisa ser texto`);
          }
      }
    }
    return values;
  }
}
