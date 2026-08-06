import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../../common/prisma/prisma.service';
import { CustomFieldsService } from '../leads/custom-fields.service';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * Pessoa de contato — entidade própria, ADITIVA.
 *
 * O Lead continua sendo a identidade do WhatsApp (telefone + pipeline) e o dono
 * da dedupe; Contact é enriquecimento opcional ligado por LeadContact. Lead
 * criado antes desta feature simplesmente não tem contato vinculado e segue
 * funcionando igual — nada aqui lê ou escreve na tabela de leads além do
 * vínculo. Ver docs/plans/2026-08-05-campos-personalizados-kommo.md.
 */

const contactCreateSchema = z.object({
  nome: z.string().min(1).max(120),
  telefone: z.string().min(8).max(30).optional().nullable(),
  email: z.string().email().max(160).optional().nullable(),
  cargo: z.string().max(80).optional().nullable(),
  company_id: z.string().uuid().optional().nullable(),
  dados_custom: z.record(z.unknown()).optional(),
});

const contactUpdateSchema = contactCreateSchema.partial();

const linkSchema = z.object({
  contact_id: z.string().uuid(),
  is_principal: z.boolean().optional(),
});

@Injectable()
export class ContactsService {
  constructor(
    private prisma: PrismaService,
    private customFields: CustomFieldsService,
  ) {}

  /** Garante que a empresa informada é do mesmo tenant. */
  private async assertCompany(companyId: string | null | undefined, tenantId: string) {
    if (!companyId) return;
    const empresa = await this.prisma.company.findFirst({
      where: { id: companyId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!empresa) throw new NotFoundException('Empresa não encontrada');
  }

  async list(user: AuthUser, q?: string) {
    return this.prisma.contact.findMany({
      where: {
        tenant_id: user.tenantId,
        ...(q
          ? {
              OR: [
                { nome: { contains: q, mode: 'insensitive' as const } },
                { email: { contains: q, mode: 'insensitive' as const } },
                { telefone: { contains: q } },
              ],
            }
          : {}),
      },
      include: { company: true },
      orderBy: { nome: 'asc' },
      take: 50,
    });
  }

  async get(id: string, user: AuthUser) {
    const contato = await this.prisma.contact.findFirst({
      where: { id, tenant_id: user.tenantId },
      include: { company: true },
    });
    if (!contato) throw new NotFoundException('Contato não encontrado');
    return contato;
  }

  async create(body: unknown, user: AuthUser) {
    const data = contactCreateSchema.parse(body);
    await this.assertCompany(data.company_id, user.tenantId);
    const custom = data.dados_custom
      ? await this.customFields.validateValues(data.dados_custom, user.tenantId, 'CONTATO')
      : {};

    return this.prisma.contact.create({
      data: {
        tenant_id: user.tenantId,
        nome: data.nome,
        telefone: data.telefone ?? null,
        email: data.email ?? null,
        cargo: data.cargo ?? null,
        company_id: data.company_id ?? null,
        // `validateValues` já coagiu tudo para tipos serializáveis; o cast só
        // troca a assinatura larga (Record<string, unknown>) pela do Prisma.
        dados_custom: custom as Prisma.InputJsonObject,
      },
      include: { company: true },
    });
  }

  async update(id: string, body: unknown, user: AuthUser) {
    const data = contactUpdateSchema.parse(body);
    const atual = await this.prisma.contact.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true, dados_custom: true },
    });
    if (!atual) throw new NotFoundException('Contato não encontrado');
    await this.assertCompany(data.company_id, user.tenantId);

    const patch: Record<string, unknown> = {};
    if (data.nome !== undefined) patch.nome = data.nome;
    if (data.telefone !== undefined) patch.telefone = data.telefone ?? null;
    if (data.email !== undefined) patch.email = data.email ?? null;
    if (data.cargo !== undefined) patch.cargo = data.cargo ?? null;
    if (data.company_id !== undefined) patch.company_id = data.company_id ?? null;
    if (data.dados_custom !== undefined) {
      // Patch parcial: mandar um campo não apaga os outros.
      const validado = await this.customFields.validateValues(
        data.dados_custom,
        user.tenantId,
        'CONTATO',
      );
      patch.dados_custom = {
        ...((atual.dados_custom as Record<string, unknown> | null) ?? {}),
        ...validado,
      };
    }

    return this.prisma.contact.update({
      where: { id },
      data: patch,
      include: { company: true },
    });
  }

  async remove(id: string, user: AuthUser) {
    const contato = await this.prisma.contact.findFirst({
      where: { id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!contato) throw new NotFoundException('Contato não encontrado');
    // Os vínculos caem por cascade; nenhum Lead é tocado.
    await this.prisma.contact.delete({ where: { id } });
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // Vínculo com o lead
  // -------------------------------------------------------------------------

  async listByLead(leadId: string, user: AuthUser) {
    await this.assertLead(leadId, user.tenantId);
    return this.prisma.leadContact.findMany({
      where: { lead_id: leadId },
      include: { contact: { include: { company: true } } },
      orderBy: [{ is_principal: 'desc' }, { created_at: 'asc' }],
    });
  }

  private async assertLead(leadId: string, tenantId: string) {
    const lead = await this.prisma.lead.findFirst({
      where: { id: leadId, tenant_id: tenantId },
      select: { id: true },
    });
    if (!lead) throw new NotFoundException('Lead não encontrado');
  }

  async link(leadId: string, body: unknown, user: AuthUser) {
    const data = linkSchema.parse(body);
    // Os dois lados checados contra o tenant: id de outro workspace vira 404,
    // nunca vínculo silencioso.
    await this.assertLead(leadId, user.tenantId);
    const contato = await this.prisma.contact.findFirst({
      where: { id: data.contact_id, tenant_id: user.tenantId },
      select: { id: true },
    });
    if (!contato) throw new NotFoundException('Contato não encontrado');

    const principal = data.is_principal ?? false;
    return this.prisma.$transaction(async (tx) => {
      if (principal) {
        // Só um principal por lead.
        await tx.leadContact.updateMany({
          where: { lead_id: leadId },
          data: { is_principal: false },
        });
      }
      return tx.leadContact.upsert({
        where: { lead_id_contact_id: { lead_id: leadId, contact_id: data.contact_id } },
        create: { lead_id: leadId, contact_id: data.contact_id, is_principal: principal },
        update: { is_principal: principal },
      });
    });
  }

  async unlink(leadId: string, contactId: string, user: AuthUser) {
    await this.assertLead(leadId, user.tenantId);
    const vinculo = await this.prisma.leadContact.findFirst({
      where: { lead_id: leadId, contact_id: contactId },
    });
    if (!vinculo) throw new NotFoundException('Vínculo não encontrado');
    await this.prisma.leadContact.delete({
      where: { lead_id_contact_id: { lead_id: leadId, contact_id: contactId } },
    });
    return { ok: true };
  }
}
