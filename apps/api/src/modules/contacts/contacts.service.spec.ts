import { NotFoundException } from '@nestjs/common';
import { ContactsService } from './contacts.service';
import { CompaniesService } from './companies.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Contato/Empresa são entidades NOVAS, aditivas. Dois riscos que estes testes
 * travam:
 *
 * 1. Vazamento entre tenants — id de outro workspace tem que virar 404, nunca
 *    um vínculo silencioso. É a falha mais cara possível num CRM multi-empresa.
 * 2. Tocar em Lead — o vínculo só pode ler o lead pra conferir o tenant. Se
 *    algum dia alguém escrever na tabela de leads por aqui, a garantia central
 *    do plano ("não mexer nos leads existentes") cai.
 */

const TENANT = 'tenant-1';

const user: AuthUser = {
  id: 'u1',
  nome: 'Operador',
  email: 'o@x.com',
  role: UserRole.OPERADOR as never,
  ativo: true,
  tenantId: TENANT,
};

const LEAD_ID = '11111111-1111-1111-1111-111111111111';
const CONTACT_ID = '22222222-2222-2222-2222-222222222222';

function makePrisma(over: Record<string, any> = {}) {
  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue({ id: LEAD_ID }),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    contact: {
      findFirst: jest.fn().mockResolvedValue({ id: CONTACT_ID }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'c-novo', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: CONTACT_ID, ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    company: {
      findFirst: jest.fn().mockResolvedValue({ id: 'emp-1' }),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'emp-novo', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'emp-1', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    leadContact: {
      findFirst: jest.fn().mockResolvedValue({ lead_id: LEAD_ID, contact_id: CONTACT_ID }),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      upsert: jest.fn().mockImplementation(({ create }: any) => Promise.resolve(create)),
      delete: jest.fn().mockResolvedValue({}),
    },
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  for (const [k, v] of Object.entries(over)) Object.assign(prisma[k], v);
  return prisma;
}

const customFields: any = {
  validateValues: jest.fn().mockImplementation((v: unknown) => Promise.resolve(v)),
};

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// Isolamento por tenant
// ---------------------------------------------------------------------------

describe('isolamento por tenant', () => {
  it('DISCRIMINANTE: vincular contato de outro tenant dá 404, não vínculo', async () => {
    const prisma = makePrisma({ contact: { findFirst: jest.fn().mockResolvedValue(null) } });
    const svc = new ContactsService(prisma, customFields);

    await expect(
      svc.link(LEAD_ID, { contact_id: CONTACT_ID }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.leadContact.upsert).not.toHaveBeenCalled();
  });

  it('DISCRIMINANTE: vincular a lead de outro tenant dá 404', async () => {
    const prisma = makePrisma({ lead: { findFirst: jest.fn().mockResolvedValue(null) } });
    const svc = new ContactsService(prisma, customFields);

    await expect(
      svc.link(LEAD_ID, { contact_id: CONTACT_ID }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.leadContact.upsert).not.toHaveBeenCalled();
  });

  it('checa o tenant nos DOIS lados do vínculo', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).link(LEAD_ID, { contact_id: CONTACT_ID }, user);

    expect(prisma.lead.findFirst.mock.calls[0][0].where.tenant_id).toBe(TENANT);
    expect(prisma.contact.findFirst.mock.calls[0][0].where.tenant_id).toBe(TENANT);
  });

  it('empresa de outro tenant não pode ser atribuída a um contato', async () => {
    const prisma = makePrisma({ company: { findFirst: jest.fn().mockResolvedValue(null) } });
    const svc = new ContactsService(prisma, customFields);

    await expect(
      svc.create({ nome: 'Adman', company_id: '33333333-3333-3333-3333-333333333333' }, user),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.contact.create).not.toHaveBeenCalled();
  });

  it('toda listagem filtra por tenant', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).list(user);
    expect(prisma.contact.findMany.mock.calls[0][0].where.tenant_id).toBe(TENANT);

    const prisma2 = makePrisma();
    await new CompaniesService(prisma2, customFields).list(user);
    expect(prisma2.company.findMany.mock.calls[0][0].where.tenant_id).toBe(TENANT);
  });
});

// ---------------------------------------------------------------------------
// A garantia central: não escrever em Lead
// ---------------------------------------------------------------------------

describe('não toca na tabela de leads', () => {
  it('DISCRIMINANTE: vincular só LÊ o lead, nunca escreve', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).link(LEAD_ID, { contact_id: CONTACT_ID }, user);

    expect(prisma.lead.findFirst).toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('desvincular também não escreve no lead', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).unlink(LEAD_ID, CONTACT_ID, user);

    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('apagar contato não escreve no lead (o vínculo cai por cascade)', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).remove(CONTACT_ID, user);

    expect(prisma.contact.delete).toHaveBeenCalled();
    expect(prisma.lead.update).not.toHaveBeenCalled();
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Regra do contato principal
// ---------------------------------------------------------------------------

describe('contato principal', () => {
  it('rebaixa o principal anterior antes de promover o novo', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).link(
      LEAD_ID,
      { contact_id: CONTACT_ID, is_principal: true },
      user,
    );

    expect(prisma.leadContact.updateMany).toHaveBeenCalledWith({
      where: { lead_id: LEAD_ID },
      data: { is_principal: false },
    });
    expect(prisma.leadContact.upsert.mock.calls[0][0].create.is_principal).toBe(true);
  });

  it('DISCRIMINANTE: vínculo comum não mexe em quem já é principal', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).link(LEAD_ID, { contact_id: CONTACT_ID }, user);

    expect(prisma.leadContact.updateMany).not.toHaveBeenCalled();
  });

  it('revincular o mesmo contato faz upsert, não duplica', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).link(LEAD_ID, { contact_id: CONTACT_ID }, user);

    expect(prisma.leadContact.upsert.mock.calls[0][0].where).toEqual({
      lead_id_contact_id: { lead_id: LEAD_ID, contact_id: CONTACT_ID },
    });
  });
});

// ---------------------------------------------------------------------------
// dados_custom
// ---------------------------------------------------------------------------

describe('dados_custom', () => {
  it('valida contato no escopo CONTATO e empresa no escopo EMPRESA', async () => {
    const prisma = makePrisma();
    await new ContactsService(prisma, customFields).create(
      { nome: 'Adman', dados_custom: { x: 1 } },
      user,
    );
    expect(customFields.validateValues).toHaveBeenCalledWith({ x: 1 }, TENANT, 'CONTATO');

    jest.clearAllMocks();
    const prisma2 = makePrisma();
    await new CompaniesService(prisma2, customFields).create(
      { nome: 'Proteção Veicular LTDA', dados_custom: { y: 2 } },
      user,
    );
    expect(customFields.validateValues).toHaveBeenCalledWith({ y: 2 }, TENANT, 'EMPRESA');
  });

  it('update mescla em vez de substituir — mandar um campo não apaga os outros', async () => {
    const prisma = makePrisma({
      contact: {
        findFirst: jest.fn().mockResolvedValue({
          id: CONTACT_ID,
          dados_custom: { antigo: 'fica', novo: 'velho' },
        }),
      },
    });
    await new ContactsService(prisma, customFields).update(
      CONTACT_ID,
      { dados_custom: { novo: 'atualizado' } },
      user,
    );

    expect(prisma.contact.update.mock.calls[0][0].data.dados_custom).toEqual({
      antigo: 'fica',
      novo: 'atualizado',
    });
  });
});
