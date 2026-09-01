import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * Ordem dos cards na coluna (decisão do cliente, 10/08/2026): lead novo e lead
 * vindo de outra coluna entram sempre no TOPO; a partir daí o usuário arrasta.
 *
 * `position` é fracionária e cresce para baixo — menor = mais acima. Topo é
 * "menor que o menor da coluna", nunca uma renumeração da coluna inteira.
 */

const LEAD_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
const DESTINO = 'b2c3d4e5-0000-4000-8000-000000000002';

function makeService(minPosition: number | null) {
  const prisma: any = {
    lead: {
      findFirst: jest.fn().mockResolvedValue({
        id: LEAD_ID,
        estagio_id: 'c3d4e5f6-0000-4000-8000-000000000003',
        tenant_id: 't1',
        position: 9999,
        responsavel_id: 'u1',
      }),
      aggregate: jest.fn().mockResolvedValue({ _min: { position: minPosition } }),
      update: jest.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: LEAD_ID, ...data }),
      ),
    },
    stage: {
      findUnique: jest.fn().mockResolvedValue({ nome: 'Coluna', auto_action: null }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    leadActivity: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn: any) =>
      typeof fn === 'function' ? fn(prisma) : Promise.all(fn),
    ),
  };
  const service = new LeadsService(
    prisma,
    {} as any, // instances
    { delPattern: jest.fn() } as any, // cache
    { emitLeadStageChanged: jest.fn(), emitLeadUpdated: jest.fn() } as any, // gateway
    {} as any, // media
    {} as any, // push
    { dispatchLeadEvent: jest.fn().mockResolvedValue(undefined) } as any,
    {} as any, // assignment
    {} as any, // customFields
    { add: jest.fn() } as any, // autoActionsQueue
    {} as any, // kanbanIndividual
  );
  return { service, prisma };
}

const user: AuthUser = {
  id: 'u1',
  nome: 'Alex',
  email: 'alex@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

/** Posição efetivamente gravada na linha do lead. */
function positionGravada(prisma: any): number | undefined {
  const calls = prisma.lead.update.mock.calls as { data: { position?: number } }[][];
  for (let i = calls.length - 1; i >= 0; i--) {
    const data = calls[i][0].data;
    if (data && data.position !== undefined) return data.position;
  }
  return undefined;
}

describe('updateStage — card entra no topo da coluna de destino', () => {
  it('DISCRIMINANTE: sem posição no pedido, fica acima do menor do destino', async () => {
    // Automação, SLA e ação em massa movem sem informar posição. Antes o lead
    // levava a posição da coluna antiga (9999) e caía num ponto arbitrário.
    const { service, prisma } = makeService(2000);

    await service.updateStage(LEAD_ID, { estagio_id: DESTINO }, user);

    expect(positionGravada(prisma)).toBe(1000);
  });

  it('coluna de destino vazia começa em 1000', async () => {
    const { service, prisma } = makeService(null);

    await service.updateStage(LEAD_ID, { estagio_id: DESTINO }, user);

    expect(positionGravada(prisma)).toBe(1000);
  });

  it('topo continua sendo topo quando a coluna já tem posição negativa', async () => {
    const { service, prisma } = makeService(-5000);

    await service.updateStage(LEAD_ID, { estagio_id: DESTINO }, user);

    expect(positionGravada(prisma)).toBe(-6000);
  });

  it('DISCRIMINANTE: posição explícita do arrasto tem precedência sobre o topo', async () => {
    // Arrastar para o meio de outra coluna manda a fração calculada entre os
    // vizinhos — o backend não pode sobrescrever isso com o topo.
    const { service, prisma } = makeService(2000);

    await service.updateStage(LEAD_ID, { estagio_id: DESTINO, position: 2500 }, user);

    expect(positionGravada(prisma)).toBe(2500);
  });
});
