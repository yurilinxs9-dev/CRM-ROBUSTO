import { TasksService } from './tasks.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { EXPORT_PAGE_SIZE } from '../../common/prisma/fetch-all-by-cursor';

/**
 * Mesmo bug do export de leads: UM findMany com `take: 10000` cortava o CSV
 * em silencio. Aqui o loop por cursor so para quando a pagina volta curta.
 */

function makeService() {
  const prisma: any = { task: { findMany: jest.fn() } };
  const service = new TasksService(prisma, {} as any /* CrmGateway */);
  return { service, prisma };
}

function makeRes() {
  return { setHeader: jest.fn(), send: jest.fn() } as any;
}

const gerente: AuthUser = {
  id: 'u-gerente',
  nome: 'Gerente',
  email: 'gerente@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

function makeTasks(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    titulo: `Tarefa ${prefix} ${i}`,
    tipo: 'FOLLOW_UP',
    status: 'PENDENTE',
    prioridade: 'MEDIA',
    scheduled_at: new Date('2026-01-01T00:00:00.000Z'),
    completed_at: null,
    duracao_min: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    lead: null,
    responsavel: null,
  }));
}

describe('TasksService.exportCsv — pagina em lotes, sem teto silencioso', () => {
  it('pagina cheia (10.000) + pagina curta: CSV traz os DOIS lotes', async () => {
    const { service, prisma } = makeService();
    const res = makeRes();
    prisma.task.findMany
      .mockResolvedValueOnce(makeTasks(EXPORT_PAGE_SIZE, 'p1'))
      .mockResolvedValueOnce(makeTasks(4, 'p2'));

    await service.exportCsv(gerente, {}, res);

    expect(prisma.task.findMany).toHaveBeenCalledTimes(2);
    const csv: string = res.send.mock.calls[0][0];
    expect(csv.split('\r\n')).toHaveLength(1 + EXPORT_PAGE_SIZE + 4);
    expect(csv).toContain(`p1-${EXPORT_PAGE_SIZE - 1}`);
    expect(csv).toContain('p2-3');
  });

  it('segunda pagina usa cursor no ultimo id da primeira, com skip:1', async () => {
    const { service, prisma } = makeService();
    prisma.task.findMany
      .mockResolvedValueOnce(makeTasks(EXPORT_PAGE_SIZE, 'q'))
      .mockResolvedValueOnce([]);

    await service.exportCsv(gerente, {}, makeRes());

    const segunda = prisma.task.findMany.mock.calls[1][0];
    expect(segunda.cursor).toEqual({ id: `q-${EXPORT_PAGE_SIZE - 1}` });
    expect(segunda.skip).toBe(1);
  });

  it('pagina unica curta: UMA query so', async () => {
    const { service, prisma } = makeService();
    const res = makeRes();
    prisma.task.findMany.mockResolvedValueOnce(makeTasks(2, 'r'));

    await service.exportCsv(gerente, {}, res);

    expect(prisma.task.findMany).toHaveBeenCalledTimes(1);
    expect(res.send.mock.calls[0][0].split('\r\n')).toHaveLength(1 + 2);
  });

  it('orderBy termina em id e o escopo do OPERADOR vale em toda pagina', async () => {
    const { service, prisma } = makeService();
    const operador: AuthUser = { ...gerente, id: 'u-op', role: UserRole.OPERADOR as unknown as AuthUser['role'] };
    prisma.task.findMany
      .mockResolvedValueOnce(makeTasks(EXPORT_PAGE_SIZE, 's'))
      .mockResolvedValueOnce([]);

    await service.exportCsv(operador, { status: 'PENDENTE' }, makeRes());

    for (const call of prisma.task.findMany.mock.calls) {
      expect(call[0].orderBy).toEqual([{ scheduled_at: 'asc' }, { id: 'asc' }]);
      expect(call[0].where.tenant_id).toBe('t1');
      expect(call[0].where.responsavel_id).toBe('u-op');
      expect(call[0].where.status).toBe('PENDENTE');
    }
  });
});
