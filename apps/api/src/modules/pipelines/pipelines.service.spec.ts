import { ZodError } from 'zod';
import { PipelinesService } from './pipelines.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * `probabilidade` da etapa alimenta a previsao ponderada do dashboard. O campo
 * vem cru do painel de configuracao, entao o Zod e a unica coisa entre o gestor
 * e um "chance de fechar: 900%" gravado no banco. `null` e valor legitimo: e
 * como se volta ao default por posicao.
 */

const TENANT = 'tenant-1';

const gerente: AuthUser = {
  id: 'g1',
  nome: 'Gerente',
  email: 'g@x.com',
  role: UserRole.GERENTE as never,
  ativo: true,
  tenantId: TENANT,
};

function montar() {
  const prisma = {
    stage: {
      findFirst: jest.fn().mockResolvedValue({ id: 's-1', tenant_id: TENANT }),
      update: jest.fn().mockImplementation(({ data }: { data: Record<string, unknown> }) =>
        Promise.resolve({ id: 's-1', ...data }),
      ),
    },
  };
  const cache = { delPattern: jest.fn().mockResolvedValue(undefined) };
  const messages = {};
  return {
    service: new PipelinesService(prisma as never, cache as never, messages as never),
    prisma,
  };
}

describe('PipelinesService.updateStage — probabilidade', () => {
  it('grava a probabilidade informada', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { probabilidade: 70 }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data.probabilidade).toBe(70);
  });

  it('aceita null para voltar ao default por posicao', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { probabilidade: null }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data.probabilidade).toBeNull();
  });

  it('aceita os extremos 0 e 100', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { probabilidade: 0 }, gerente);
    await service.updateStage('s-1', { probabilidade: 100 }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data.probabilidade).toBe(0);
    expect(prisma.stage.update.mock.calls[1][0].data.probabilidade).toBe(100);
  });

  /** ZodError vira 400 no AllExceptionFilter global. */
  it('recusa 101 e nao chega no banco', async () => {
    const { service, prisma } = montar();

    await expect(service.updateStage('s-1', { probabilidade: 101 }, gerente)).rejects.toBeInstanceOf(
      ZodError,
    );
    expect(prisma.stage.update).not.toHaveBeenCalled();
  });

  it('recusa negativo e fracionario', async () => {
    const { service } = montar();

    await expect(service.updateStage('s-1', { probabilidade: -1 }, gerente)).rejects.toBeInstanceOf(
      ZodError,
    );
    await expect(
      service.updateStage('s-1', { probabilidade: 33.3 }, gerente),
    ).rejects.toBeInstanceOf(ZodError);
  });

  it('corpo sem probabilidade nao toca no campo', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { nome: 'Proposta' }, gerente);

    expect(prisma.stage.update.mock.calls[0][0].data).toEqual({ nome: 'Proposta' });
  });
});

/**
 * A rota PATCH /stages/:id e liberada para OPERADOR (renomear/cor no dia a
 * dia), mas o mesmo endpoint carrega campos estruturais. A guarda fina do
 * service e o que impede um operador de mexer em automacao/SLA/probabilidade.
 */
describe('PipelinesService.updateStage — guarda fina por papel', () => {
  const operador: AuthUser = { ...gerente, id: 'o1', nome: 'Isamara', role: UserRole.OPERADOR as never };

  it('operador renomeia e troca cor', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { nome: 'Orcamento', cor: '#AA00FF' }, operador);

    expect(prisma.stage.update.mock.calls[0][0].data).toEqual({ nome: 'Orcamento', cor: '#AA00FF' });
  });

  it.each([
    { probabilidade: 50 },
    { is_won: true },
    { sla_config: { duration: 1 } },
    { cadence_config: [] },
    { nome: 'ok', max_dias: 3 },
  ])('operador com campo estrutural %j leva 403 e nada e gravado', async (payload) => {
    const { service, prisma } = montar();

    await expect(service.updateStage('s-1', payload, operador)).rejects.toMatchObject({
      status: 403,
    });
    expect(prisma.stage.update).not.toHaveBeenCalled();
  });

  it('gerente segue alterando campos estruturais', async () => {
    const { service, prisma } = montar();

    await service.updateStage('s-1', { is_won: true, probabilidade: 90 }, gerente);

    expect(prisma.stage.update).toHaveBeenCalled();
  });

  it('super admin passa como gestor', async () => {
    const { service, prisma } = montar();
    const admin: AuthUser = { ...gerente, role: UserRole.SUPER_ADMIN as never };

    await service.updateStage('s-1', { probabilidade: 10 }, admin);

    expect(prisma.stage.update).toHaveBeenCalled();
  });
});
