import { LeadsService } from './leads.service';
import { UserRole } from '@/common/types/roles';
import type { AuthUser } from '../../common/types/auth-user';
import { EXPORT_PAGE_SIZE } from '../../common/prisma/fetch-all-by-cursor';

/**
 * Bug: exportCsv fazia UM findMany com `take: 10000`. Tenant com mais de 10k
 * leads baixava um CSV incompleto e nada — nem header, nem log, nem aviso na
 * tela — dizia que faltava linha. Um tenant em producao estava em ~9.974,
 * prestes a cruzar o teto sem perceber.
 *
 * Fix: pagina por cursor em lotes de 10.000 ate a pagina voltar curta.
 * Cursor (e nao `skip`) para nao pular/duplicar linha se entrar lead novo
 * durante a exportacao; `orderBy` ganhou `id` como desempate estavel.
 */

function makeService() {
  const prisma: any = {
    lead: { findMany: jest.fn() },
    // exportCsv monta o `where` com `buildVisibilityWhere`, que precisa do modo
    // do tenant e do modo foco do usuario. Estes testes nao sao sobre nenhum
    // dos dois: modo INDIVIDUAL e sem foco em todos eles.
    tenant: { findUnique: jest.fn().mockResolvedValue({ pool_enabled: false }) },
    user: { findUnique: jest.fn().mockResolvedValue({ focus_mode: false }) },
  };
  const service = new LeadsService(
    prisma,
    {} as any, // InstancesService
    {} as any, // RedisCacheService
    {} as any, // CrmGateway
    {} as any, // MediaService
    {} as any, // PushService
    {} as any, // OutboundWebhooksService
    {} as any, // AssignmentService
    {} as any, // CustomFieldsService
    {} as any, // autoActionsQueue (BullMQ)
    {} as any, // KanbanIndividualService
  );
  return { service, prisma };
}

function makeRes() {
  return {
    setHeader: jest.fn(),
    send: jest.fn(),
  } as any;
}

const gerente: AuthUser = {
  id: 'u-gerente',
  nome: 'Gerente',
  email: 'gerente@x.com',
  role: UserRole.GERENTE as unknown as AuthUser['role'],
  ativo: true,
  tenantId: 't1',
};

function makeLeads(n: number, prefix: string) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${i}`,
    nome: `Lead ${prefix} ${i}`,
    telefone: `+55319000000${i}`,
    email: null,
    temperatura: 'FRIO',
    valor_estimado: null,
    mensagens_nao_lidas: 0,
    ultima_interacao: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    tags: [],
    pipeline: { nome: 'Funil' },
    estagio: { nome: 'Novo' },
    responsavel: null,
  }));
}

describe('LeadsService.exportCsv — pagina em lotes, sem teto silencioso', () => {
  it('pagina cheia (10.000) + pagina curta: CSV traz os DOIS lotes', async () => {
    const { service, prisma } = makeService();
    const res = makeRes();
    prisma.lead.findMany
      .mockResolvedValueOnce(makeLeads(EXPORT_PAGE_SIZE, 'p1'))
      .mockResolvedValueOnce(makeLeads(3, 'p2'));

    await service.exportCsv(gerente, {}, res);

    expect(prisma.lead.findMany).toHaveBeenCalledTimes(2);
    const csv: string = res.send.mock.calls[0][0];
    const linhas = csv.split('\r\n');
    // header + 10.000 + 3
    expect(linhas).toHaveLength(1 + EXPORT_PAGE_SIZE + 3);
    expect(csv).toContain('p1-0');
    expect(csv).toContain(`p1-${EXPORT_PAGE_SIZE - 1}`);
    expect(csv).toContain('p2-2');
  });

  it('segunda pagina usa cursor no ultimo id da primeira, com skip:1', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findMany
      .mockResolvedValueOnce(makeLeads(EXPORT_PAGE_SIZE, 'q'))
      .mockResolvedValueOnce([]);

    await service.exportCsv(gerente, {}, makeRes());

    const segunda = prisma.lead.findMany.mock.calls[1][0];
    expect(segunda.cursor).toEqual({ id: `q-${EXPORT_PAGE_SIZE - 1}` });
    expect(segunda.skip).toBe(1);
    expect(segunda.take).toBe(EXPORT_PAGE_SIZE);
  });

  it('pagina unica curta: UMA query so (nao paga ida extra ao banco)', async () => {
    const { service, prisma } = makeService();
    const res = makeRes();
    prisma.lead.findMany.mockResolvedValueOnce(makeLeads(5, 'r'));

    await service.exportCsv(gerente, {}, res);

    expect(prisma.lead.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.lead.findMany.mock.calls[0][0].cursor).toBeUndefined();
    const csv: string = res.send.mock.calls[0][0];
    expect(csv.split('\r\n')).toHaveLength(1 + 5);
  });

  it('orderBy termina em id: desempate unico, exigido pela paginacao por cursor', async () => {
    const { service, prisma } = makeService();
    prisma.lead.findMany.mockResolvedValueOnce([]);

    await service.exportCsv(gerente, {}, makeRes());

    const args = prisma.lead.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
  });

  it('filtros e escopo do OPERADOR continuam valendo em toda pagina', async () => {
    const { service, prisma } = makeService();
    const operador: AuthUser = { ...gerente, id: 'u-op', role: UserRole.OPERADOR as unknown as AuthUser['role'] };
    prisma.lead.findMany
      .mockResolvedValueOnce(makeLeads(EXPORT_PAGE_SIZE, 's'))
      .mockResolvedValueOnce([]);

    await service.exportCsv(operador, { temperatura: 'QUENTE' }, makeRes());

    for (const call of prisma.lead.findMany.mock.calls) {
      expect(call[0].where.tenant_id).toBe('t1');
      // Escopo do OPERADOR agora vem de `buildVisibilityWhere`: as proprias
      // mais a nuvem de devolvidos, o mesmo recorte do board.
      expect(call[0].where.OR).toEqual([
        { responsavel_id: 'u-op' },
        { responsavel_id: null, returned_at: { not: null }, is_private: false },
      ]);
      expect(call[0].where.temperatura).toBe('QUENTE');
    }
  });
});
