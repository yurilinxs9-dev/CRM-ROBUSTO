import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Salvar a ficha de um lead SEM responsável voltava 400 "Campos inválidos:
 * responsavel_id". A ficha manda o campo sempre; num lead do pool ele sobe
 * vazio (null vindo do banco, ou '' do Select controlado) e o schema exigia
 * uuid. Na prática: adicionar uma tag num lead não atribuído era impossível.
 *
 * Vazio significa "não mexe no responsável" — remover dono é o botão
 * "Devolver ao Escritório", que tem endpoint próprio.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const OUTRO_USER = 'e5f6a7b8-0000-4000-8000-000000000009';

function makeService() {
  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        tenant_id: 't1',
        nome: 'Ilda',
        responsavel_id: null,
        estagio_id: 'c3d4e5f6-0000-4000-8000-000000000003',
      }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: LEAD_ID, ...data }),
      ),
    },
    tag: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn() },
    leadTag: { deleteMany: jest.fn(), createMany: jest.fn() },
    leadActivity: { create: jest.fn().mockResolvedValue({}) },
    customFieldDef: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((fn: any) =>
      typeof fn === 'function' ? fn(prisma) : Promise.all(fn),
    ),
  };
  const service = new LeadsService(
    prisma,
    {} as any,
    { delPattern: jest.fn() } as any,
    { emitLeadUpdated: jest.fn() } as any,
    {} as any,
    {} as any,
    { dispatchLeadEvent: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any,
    { validate: jest.fn().mockResolvedValue({}) } as any,
    { add: jest.fn() } as any,
  );
  return { service, prisma };
}

const user: AuthUser = {
  id: 'd4e5f6a7-0000-4000-8000-000000000004',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

describe('update — lead sem responsável', () => {
  it('DISCRIMINANTE: salvar tags com responsavel_id null não estoura', async () => {
    const { service } = makeService();

    await expect(
      service.update(LEAD_ID, { responsavel_id: null, tags: ['+150 MIL'] }, user),
    ).resolves.toBeDefined();
  });

  it('DISCRIMINANTE: string vazia também passa', async () => {
    const { service } = makeService();

    await expect(
      service.update(LEAD_ID, { responsavel_id: '', tags: ['ADESÃO'] }, user),
    ).resolves.toBeDefined();
  });

  it('vazio não apaga o responsável — o campo é ignorado', async () => {
    const { service, prisma } = makeService();

    await service.update(LEAD_ID, { responsavel_id: '', nome: 'Ilda Maria' }, user);

    const data = prisma.lead.update.mock.calls.at(-1)[0].data;
    expect(data).not.toHaveProperty('responsavel_id');
    expect(data.nome).toBe('Ilda Maria');
  });

  it('responsável de verdade continua sendo gravado', async () => {
    const { service, prisma } = makeService();

    await service.update(LEAD_ID, { responsavel_id: OUTRO_USER }, user);

    const data = prisma.lead.update.mock.calls.at(-1)[0].data;
    expect(data.responsavel_id).toBe(OUTRO_USER);
  });

  it('uuid invalido continua sendo recusado', async () => {
    const { service } = makeService();

    await expect(
      service.update(LEAD_ID, { responsavel_id: 'nao-e-uuid' }, user),
    ).rejects.toThrow();
  });
});
