import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomFieldsService } from '../leads/custom-fields.service';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Empresa do contato. Como Contact, é aditiva: NÃO substitui `Lead.empresa`,
 * que segue guardando o dado legado dos leads já existentes. A consolidação
 * das duas (com backfill) é um trabalho à parte — ver "Duplicação consciente"
 * no plano da feature.
 */

const companyCreateSchema = z.object({
  nome: z.string().min(1).max(120),
  telefone: z.string().min(8).max(30).optional().nullable(),
  email: z.string().email().max(160).optional().nullable(),
  site: z.string().url().max(200).optional().nullable(),
  endereco: z.string().max(300).optional().nullable(),
  dados_custom: z.record(z.unknown()).optional(),
});

const companyUpdateSchema = companyCreateSchema.partial();

@Injectable()
export class CompaniesService {
  constructor(
    private prisma: PrismaService,
    private customFields: CustomFieldsService,
  ) {}

  async list(user: AuthUser, q?: string) {
    return this.prisma.company.findMany({
      where: {
        tenant_id: user.tenantId,
        ...(q ? { nome: { contains: q, mode: 'insensitive' as const } } : {}),
      },
      orderBy: { nome: 'asc' },
      take: 50,
    });
  }

  async get(id: string, user: AuthUser) {
    const empresa = await this.prisma.company.findFirst({
      where: { id, tenant_id: user.tenantId },
      include: { contacts: true },
    });
    if (!empresa) throw new NotFoundException('Empresa não encontrada');
    return empresa;
  }

  async create(body: unknown, user: AuthUser) {
    const data = companyCreateSchema.parse(body);
    const custom = data.dados_custom
      ? await this.customFields.validateValues(data.dados_custom, user.tenantId, 'EMPRESA')
      : {};

    return this.prisma.company.create({
      data: {
        tenant_id: user.tenantId,
        nome: data.nome,
        telefone: data.telefone ?? null,
        email: data.email ?? null,
        site: data.site ?? null,
        endereco: data.endereco ?? null,
        // Ver nota equivalente em contacts.service.ts.
        dados_custom: custom as Prisma.InputJsonObject,
      },
    });
  }

  async update(id: string, body: unknown, user: AuthUser) {
    const data = companyUpdateSchema.parse(body);
    const atual = await this.prisma.company.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true, dados_custom: true },
    });
    if (!atual) throw new NotFoundException('Empresa não encontrada');

    const patch: Record<string, unknown> = {};
    if (data.nome !== undefined) patch.nome = data.nome;
    if (data.telefone !== undefined) patch.telefone = data.telefone ?? null;
    if (data.email !== undefined) patch.email = data.email ?? null;
    if (data.site !== undefined) patch.site = data.site ?? null;
    if (data.endereco !== undefined) patch.endereco = data.endereco ?? null;
    if (data.dados_custom !== undefined) {
      const validado = await this.customFields.validateValues(
        data.dados_custom,
        user.tenantId,
        'EMPRESA',
      );
      patch.dados_custom = {
        ...((atual.dados_custom as Record<string, unknown> | null) ?? {}),
        ...validado,
      };
    }

    return this.prisma.company.update({ where: { id }, data: patch });
  }

  async remove(id: string, user: AuthUser) {
    const empresa = await this.prisma.company.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!empresa) throw new NotFoundException('Empresa não encontrada');
    // Contatos ficam sem empresa (onDelete: SetNull), não somem junto.
    await this.prisma.company.delete({ where: { id } });
    return { ok: true };
  }
}
