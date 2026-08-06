import { BadRequestException, NotFoundException } from '@nestjs/common';
import { CustomFieldsService } from './custom-fields.service';
import { NATIVE_FIELDS } from './field-schema';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Bootstrap dos campos nativos + regras de escopo.
 *
 * O requisito do produto é "cada empresa vem crua": tenant novo NÃO recebe
 * campo de negócio nenhum, só a estrutura mínima (grupo de sistema + campos
 * nativos) sem a qual a ficha do lead não desenha. Estes testes travam isso,
 * e travam também as proteções que impedem a empresa de esconder campo que o
 * CRM usa como infraestrutura.
 */

const TENANT = 'tenant-1';
const OUTRO_TENANT = 'tenant-2';

const user: AuthUser = {
  id: 'u1',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as never,
  ativo: true,
  tenantId: TENANT,
};

/** Grupos de sistema que o bootstrap cria, um por escopo. */
const GRUPOS_SISTEMA = [
  { id: 'g-lead', escopo: 'LEAD' },
  { id: 'g-contato', escopo: 'CONTATO' },
  { id: 'g-empresa', escopo: 'EMPRESA' },
];

function makePrisma(over: Record<string, any> = {}) {
  const prisma: any = {
    customFieldGroup: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({ count: 3 }),
      findMany: jest.fn().mockResolvedValue(GRUPOS_SISTEMA),
      findFirst: jest.fn().mockResolvedValue({ id: 'g-lead', escopo: 'LEAD', is_system: true }),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'g-novo', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'g-novo', ...data })),
      delete: jest.fn().mockResolvedValue({}),
    },
    customFieldDef: {
      count: jest.fn().mockResolvedValue(0),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'f-novo', ...data })),
      update: jest.fn().mockImplementation(({ data }: any) => Promise.resolve({ id: 'f-1', ...data })),
    },
    $transaction: jest.fn((arg: unknown) =>
      Array.isArray(arg) ? Promise.all(arg as Promise<unknown>[]) : Promise.resolve([]),
    ),
  };
  Object.assign(prisma.customFieldGroup, over.customFieldGroup ?? {});
  Object.assign(prisma.customFieldDef, over.customFieldDef ?? {});
  return prisma;
}

function makeService(prisma: any) {
  return new CustomFieldsService(prisma);
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

describe('bootstrap', () => {
  it('cria um grupo de sistema por escopo quando o tenant não tem nenhum', async () => {
    const prisma = makePrisma();
    await makeService(prisma).schema(user);

    const [{ data }] = prisma.customFieldGroup.createMany.mock.calls[0];
    expect(data).toHaveLength(3);
    expect(data.map((g: any) => g.escopo).sort()).toEqual(['CONTATO', 'EMPRESA', 'LEAD']);
    expect(data.every((g: any) => g.is_system === true)).toBe(true);
    expect(data.every((g: any) => g.tenant_id === TENANT)).toBe(true);
  });

  it('cria exatamente os campos nativos — e NENHUM campo de negócio', async () => {
    const prisma = makePrisma();
    await makeService(prisma).schema(user);

    const [{ data }] = prisma.customFieldDef.createMany.mock.calls[0];
    const esperado =
      NATIVE_FIELDS.LEAD.length + NATIVE_FIELDS.CONTATO.length + NATIVE_FIELDS.EMPRESA.length;
    expect(data).toHaveLength(esperado);
    // "Vir cru" = todo campo criado é nativo. Nenhum extra.
    expect(data.every((f: any) => f.native_key !== null && f.native_key !== undefined)).toBe(true);
  });

  it('DISCRIMINANTE: não faz nada quando o tenant já tem grupos', async () => {
    const prisma = makePrisma({ customFieldGroup: { count: jest.fn().mockResolvedValue(3) } });
    await makeService(prisma).schema(user);

    expect(prisma.customFieldGroup.createMany).not.toHaveBeenCalled();
    expect(prisma.customFieldDef.createMany).not.toHaveBeenCalled();
  });

  it('é idempotente: usa skipDuplicates nos dois createMany', async () => {
    const prisma = makePrisma();
    await makeService(prisma).schema(user);

    expect(prisma.customFieldGroup.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
    expect(prisma.customFieldDef.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('adota campos órfãos no grupo do próprio escopo, depois dos nativos', async () => {
    const prisma = makePrisma();
    await makeService(prisma).schema(user);

    const chamadas = prisma.customFieldDef.updateMany.mock.calls;
    expect(chamadas).toHaveLength(3);
    const lead = chamadas.find((c: any) => c[0].where.escopo === 'LEAD')[0];
    expect(lead.where.group_id).toBeNull();
    expect(lead.data.group_id).toBe('g-lead');
    // Nativos ocupam ordem 0..N; o deslocamento evita intercalar.
    expect(lead.data.ordem.increment).toBeGreaterThan(0);
  });

  it('DISCRIMINANTE: campo customizado com a mesma key de um nativo não é sobrescrito', async () => {
    // Tenant que criou um campo "Nome" antes desta feature.
    const prisma = makePrisma({
      customFieldDef: {
        findMany: jest.fn().mockResolvedValue([{ escopo: 'LEAD', key: 'nome' }]),
      },
    });
    await makeService(prisma).schema(user);

    const [{ data }] = prisma.customFieldDef.createMany.mock.calls[0];
    const nativoNome = data.find((f: any) => f.escopo === 'LEAD' && f.native_key === 'nome');
    // Recebe key distinta; native_key continua apontando pra coluna certa, então
    // os dois convivem e nenhum valor do tenant se perde.
    expect(nativoNome.key).toBe('nome__nativo');
    expect(nativoNome.native_key).toBe('nome');
  });
});

// ---------------------------------------------------------------------------
// Leitura
// ---------------------------------------------------------------------------

describe('list (compatibilidade)', () => {
  it('devolve só campo customizado de lead — o formato que a rota já tinha', async () => {
    const prisma = makePrisma({ customFieldGroup: { count: jest.fn().mockResolvedValue(3) } });
    await makeService(prisma).list(user);

    const [{ where }] = prisma.customFieldDef.findMany.mock.calls[0];
    expect(where).toMatchObject({
      tenant_id: TENANT,
      active: true,
      escopo: 'LEAD',
      native_key: null,
    });
  });
});

// ---------------------------------------------------------------------------
// Proteções dos campos nativos
// ---------------------------------------------------------------------------

describe('proteção dos nativos', () => {
  const nativoProtegido = {
    id: 'f-tel',
    tenant_id: TENANT,
    escopo: 'LEAD',
    native_key: 'telefone',
    nome: 'Telefone/WhatsApp',
    tipo: 'phone',
    api_only: false,
  };

  it('não deixa desativar campo nativo', async () => {
    const prisma = makePrisma({
      customFieldDef: { findFirst: jest.fn().mockResolvedValue(nativoProtegido) },
    });
    await expect(makeService(prisma).deactivate('f-tel', user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('DISCRIMINANTE: não deixa esconder o telefone (quebraria envio e dedupe)', async () => {
    const prisma = makePrisma({
      customFieldDef: { findFirst: jest.fn().mockResolvedValue(nativoProtegido) },
    });
    await expect(
      makeService(prisma).update('f-tel', { visible: false }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('mas deixa esconder um nativo removível, como o e-mail', async () => {
    const prisma = makePrisma({
      customFieldDef: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ ...nativoProtegido, id: 'f-mail', native_key: 'email' }),
      },
    });
    await expect(
      makeService(prisma).update('f-mail', { visible: false }, user),
    ).resolves.toBeDefined();
  });

  it('deixa renomear nativo — é como a empresa personaliza o rótulo', async () => {
    const prisma = makePrisma({
      customFieldDef: { findFirst: jest.fn().mockResolvedValue(nativoProtegido) },
    });
    await expect(
      makeService(prisma).update('f-tel', { nome: 'WhatsApp do cliente' }, user),
    ).resolves.toBeDefined();
  });

  it('não deixa mudar "Apenas API" de um nativo', async () => {
    const prisma = makePrisma({
      customFieldDef: {
        findFirst: jest
          .fn()
          .mockResolvedValue({ ...nativoProtegido, native_key: 'proximo_followup', api_only: true }),
      },
    });
    await expect(
      makeService(prisma).update('f-x', { api_only: false }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// Isolamento por tenant e escopo
// ---------------------------------------------------------------------------

describe('isolamento', () => {
  it('update não acha campo de outro tenant', async () => {
    const prisma = makePrisma({
      customFieldDef: { findFirst: jest.fn().mockResolvedValue(null) },
    });
    await expect(makeService(prisma).update('f-alheio', { nome: 'x' }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    // A busca SEMPRE filtra por tenant — nunca confia no id sozinho.
    expect(prisma.customFieldDef.findFirst.mock.calls[0][0].where.tenant_id).toBe(TENANT);
  });

  it('DISCRIMINANTE: recusa criar campo em grupo de outro escopo', async () => {
    const prisma = makePrisma({
      customFieldGroup: {
        count: jest.fn().mockResolvedValue(3),
        findFirst: jest.fn().mockResolvedValue({ id: 'g-contato', escopo: 'CONTATO' }),
      },
    });
    await expect(
      makeService(prisma).create(
        { nome: 'Plano', tipo: 'text', escopo: 'LEAD', group_id: '11111111-1111-1111-1111-111111111111' },
        user,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('reorder recusa lote com id que não é do tenant', async () => {
    const prisma = makePrisma({
      customFieldGroup: { count: jest.fn().mockResolvedValue(3) },
      // Pediu 2, o banco só devolveu 1 → o outro não é deste tenant.
      customFieldDef: {
        findMany: jest.fn().mockResolvedValue([{ id: '11111111-1111-1111-1111-111111111111', escopo: 'LEAD' }]),
      },
    });
    await expect(
      makeService(prisma).reorder(
        [
          { id: '11111111-1111-1111-1111-111111111111', group_id: 'aaaaaaaa-1111-1111-1111-111111111111', ordem: 0 },
          { id: '22222222-2222-2222-2222-222222222222', group_id: 'aaaaaaaa-1111-1111-1111-111111111111', ordem: 1 },
        ],
        user,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('não deixa apagar o grupo de sistema', async () => {
    const prisma = makePrisma({
      customFieldGroup: {
        findFirst: jest.fn().mockResolvedValue({ id: 'g-lead', escopo: 'LEAD', is_system: true }),
      },
    });
    await expect(makeService(prisma).deleteGroup('g-lead', user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ---------------------------------------------------------------------------
// validateValues
// ---------------------------------------------------------------------------

describe('validateValues', () => {
  const defs = [
    { key: 'plano', nome: 'Plano', tipo: 'select', options: ['Ouro', 'Prata'], native_key: null, api_only: false },
    { key: 'ticket', nome: 'Ticket', tipo: 'currency', options: null, native_key: null, api_only: false },
    { key: 'nome', nome: 'Nome', tipo: 'text', options: null, native_key: 'nome', api_only: false },
    { key: 'score_ia', nome: 'Score IA', tipo: 'number', options: null, native_key: null, api_only: true },
  ];
  const prismaCom = () =>
    makePrisma({ customFieldDef: { findMany: jest.fn().mockResolvedValue(defs) } });

  it('rejeita chave desconhecida', async () => {
    await expect(
      makeService(prismaCom()).validateValues({ inexistente: 'x' }, TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('DISCRIMINANTE: rejeita campo nativo dentro de dados_custom', async () => {
    // Deixar entrar criaria uma cópia no Json que sombrearia a coluna real.
    await expect(
      makeService(prismaCom()).validateValues({ nome: 'Adman' }, TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('coage o valor, não só valida', async () => {
    const out = await makeService(prismaCom()).validateValues({ ticket: '1.234,56' }, TENANT);
    expect(out).toEqual({ ticket: 1234.56 });
  });

  it('valida contra as opções do select', async () => {
    await expect(
      makeService(prismaCom()).validateValues({ plano: 'Bronze' }, TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      makeService(prismaCom()).validateValues({ plano: 'Ouro' }, TENANT),
    ).resolves.toEqual({ plano: 'Ouro' });
  });

  it('DISCRIMINANTE: campo api_only é bloqueado na UI e liberado na API pública', async () => {
    await expect(
      makeService(prismaCom()).validateValues({ score_ia: 10 }, TENANT),
    ).rejects.toBeInstanceOf(BadRequestException);

    await expect(
      makeService(prismaCom()).validateValues({ score_ia: 10 }, TENANT, 'LEAD', {
        fromPublicApi: true,
      }),
    ).resolves.toEqual({ score_ia: 10 });
  });

  it('consulta as definições do escopo pedido e do tenant certo', async () => {
    const prisma = prismaCom();
    await makeService(prisma).validateValues({}, OUTRO_TENANT, 'EMPRESA');
    expect(prisma.customFieldDef.findMany.mock.calls[0][0].where).toMatchObject({
      tenant_id: OUTRO_TENANT,
      escopo: 'EMPRESA',
      active: true,
    });
  });
});
