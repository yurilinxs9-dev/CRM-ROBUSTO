import { UsersService } from './users.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * GATE do kanban individual: membro NOVO nascia sem board.
 *
 * `enable()` clona o conjunto base de colunas para cada membro que ja existia
 * no tenant. Quem entra DEPOIS (contratacao nova, que e o caso comum num
 * tenant que ja usa a feature) nao passava por lugar nenhum que clonasse —
 * `Stage.user_id = <novo>` ficava vazio e o Kanban dele abria em branco, sem
 * erro nenhum, ate alguem desligar e religar o toggle.
 *
 * Regras que esta suite trava:
 *  - so clona com o toggle LIGADO (tenant que nao usa a feature nao ganha
 *    nenhuma query nova alem do isOn);
 *  - so para papel que tem board (`PAPEIS_COM_BOARD`) — VISUALIZADOR nao move
 *    lead e le a base;
 *  - clonar e acessorio: falha no clone NAO pode derrubar a criacao do usuario,
 *    que ja esta gravado nesse ponto.
 */

const TENANT = 'tenant-1';

const gerente: AuthUser = {
  id: 'g1',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: TENANT,
};

function montar(opts: { kanbanOn?: boolean; stagesExistentes?: number } = {}) {
  const prisma: any = {
    user: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn().mockResolvedValue({ id: 'novo-1', nome: 'Novo' }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'alvo-1', ...data }),
      ),
    },
    stage: { count: jest.fn().mockResolvedValue(opts.stagesExistentes ?? 0) },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn((arg: unknown) =>
      typeof arg === 'function' ? (arg as (tx: unknown) => unknown)(prisma) : Promise.all(arg as Promise<unknown>[]),
    ),
  };
  const media: any = {};
  const sectors: any = { assertActiveForTenant: jest.fn().mockResolvedValue('setor-1') };
  const kanbanIndividual: any = {
    isOn: jest.fn().mockResolvedValue(opts.kanbanOn ?? false),
    cloneBaseForUser: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service: new UsersService(prisma, media, sectors, kanbanIndividual),
    prisma,
    kanbanIndividual,
  };
}

const novoOperador = {
  nome: 'Isamara',
  email: 'isamara@x.com',
  senha: 'senha-forte-123',
  role: UserRole.OPERADOR as string,
};

describe('UsersService.createTeamMember — board do membro novo', () => {
  it('toggle ON + papel com board: clona a base para o usuario recem-criado', async () => {
    const { service, prisma, kanbanIndividual } = montar({ kanbanOn: true });

    await service.createTeamMember(gerente, novoOperador);

    expect(kanbanIndividual.cloneBaseForUser).toHaveBeenCalledTimes(1);
    const [, tenantId, userId] = kanbanIndividual.cloneBaseForUser.mock.calls[0];
    expect(tenantId).toBe(TENANT);
    // O id e o mesmo que foi para o INSERT — nao o do gerente que criou.
    expect(typeof userId).toBe('string');
    expect(userId).not.toBe(gerente.id);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('toggle OFF: nao clona nada (tenant que nao usa a feature nao muda)', async () => {
    const { service, kanbanIndividual } = montar({ kanbanOn: false });

    await service.createTeamMember(gerente, novoOperador);

    expect(kanbanIndividual.cloneBaseForUser).not.toHaveBeenCalled();
  });

  it('toggle ON + VISUALIZADOR: nao ganha colunas (ele le a base)', async () => {
    const { service, kanbanIndividual } = montar({ kanbanOn: true });

    await service.createTeamMember(gerente, {
      ...novoOperador,
      role: UserRole.VISUALIZADOR as string,
    });

    expect(kanbanIndividual.cloneBaseForUser).not.toHaveBeenCalled();
  });

  it('toggle ON mas o membro ja tem colunas: nao duplica o board', async () => {
    const { service, kanbanIndividual } = montar({ kanbanOn: true, stagesExistentes: 4 });

    await service.createTeamMember(gerente, novoOperador);

    expect(kanbanIndividual.cloneBaseForUser).not.toHaveBeenCalled();
  });

  it('falha ao clonar NAO derruba a criacao: o usuario ja esta gravado', async () => {
    const { service, kanbanIndividual } = montar({ kanbanOn: true });
    kanbanIndividual.cloneBaseForUser.mockRejectedValue(new Error('P2028'));

    await expect(service.createTeamMember(gerente, novoOperador)).resolves.toEqual({
      id: 'novo-1',
      nome: 'Novo',
    });
  });
});

/**
 * Vincular um usuario existente e a outra porta de entrada da equipe: o efeito
 * no board e identico ao de criar do zero.
 */
describe('UsersService.linkTeamMember — board do membro vinculado', () => {
  const alvo = { id: 'alvo-1', role: UserRole.OPERADOR, tenant_id: 'outro-tenant' };

  it('toggle ON + papel com board: clona a base para o vinculado', async () => {
    const { service, prisma, kanbanIndividual } = montar({ kanbanOn: true });
    prisma.user.findUnique.mockResolvedValue(alvo);

    await service.linkTeamMember(gerente, {
      email: 'alvo@x.com',
      role: UserRole.OPERADOR as string,
    });

    expect(kanbanIndividual.cloneBaseForUser).toHaveBeenCalledTimes(1);
    expect(kanbanIndividual.cloneBaseForUser.mock.calls[0][2]).toBe('alvo-1');
  });

  it('toggle OFF: nao clona nada', async () => {
    const { service, prisma, kanbanIndividual } = montar({ kanbanOn: false });
    prisma.user.findUnique.mockResolvedValue(alvo);

    await service.linkTeamMember(gerente, {
      email: 'alvo@x.com',
      role: UserRole.OPERADOR as string,
    });

    expect(kanbanIndividual.cloneBaseForUser).not.toHaveBeenCalled();
  });
});
