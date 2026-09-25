import { LeadsService } from './leads.service';

it('conta além da página e exporta com o mesmo tenant, visibilidade e período', async () => {
  const prisma = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ pool_enabled: false }) },
    user: { findUnique: jest.fn().mockResolvedValue({ focus_mode: false }) },
    lead: { findMany: jest.fn().mockResolvedValue([]), count: jest.fn().mockResolvedValue(153) },
  };
  const cache = { get: jest.fn(), set: jest.fn() };
  type Args = ConstructorParameters<typeof LeadsService>;
  const service = new LeadsService(...([prisma, {}, cache, {}, {}, {}, {}, {}, {}, {}, {}] as unknown as Args));
  const user = { id: 'aline', tenantId: 'clinica', role: 'OPERADOR' } as Parameters<LeadsService['findAll']>[0];
  const filters = { created_from: '2026-09-01T00:00:00.000-03:00', created_to: '2026-09-25T23:59:59.999-03:00', origem: 'MANUAL' };
  expect(await service.findAll(user, { ...filters, include_total: 'true', limit: '50', offset: '50' })).toEqual({ data: [], total: 153 });
  const where = prisma.lead.findMany.mock.calls[0][0].where;
  expect(where.tenant_id).toBe('clinica');
  expect(where.OR).toBeDefined();
  expect(prisma.lead.count).toHaveBeenCalledWith({ where });
  expect(where.AND).toContainEqual({ created_at: { gte: new Date('2026-09-01T03:00:00Z'), lte: new Date('2026-09-26T02:59:59.999Z') } });
  await service.exportCsv(user, filters, { setHeader: jest.fn(), send: jest.fn() } as unknown as Parameters<LeadsService['exportCsv']>[2]);
  expect(prisma.lead.findMany.mock.calls[1][0].where).toEqual(where);
});
