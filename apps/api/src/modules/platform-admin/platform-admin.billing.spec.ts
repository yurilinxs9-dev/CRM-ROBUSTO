import { PlatformAdminService } from './platform-admin.service';
import type { AuthUser } from '../../common/types/auth-user';

const admin = { id: 'adm', email: 'a@a', tenantId: 't-adm', role: 'SUPER_ADMIN' } as unknown as AuthUser;
const d = (s: string) => new Date(`${s}T12:00:00Z`);

function makeSvc(prismaPatch: Record<string, unknown>) {
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ platform_scopes: ['*'] }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      updateMany: jest.fn(),
    },
    tenant: {
      findUnique: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockImplementation(({ data }: { data: unknown }) => Promise.resolve(data)),
    },
    whatsappInstance: { groupBy: jest.fn().mockResolvedValue([]) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    ...prismaPatch,
  };
  const svc = new PlatformAdminService(prisma as never, {} as never, {} as never);
  return { svc, prisma };
}

describe('markTenantPaid', () => {
  it('avanca paid_until pelo ciclo a partir de max(paid_until, hoje) — atrasado nao ganha credito retroativo', async () => {
    const { svc, prisma } = makeSvc({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2026-08-01') }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await svc.markTenantPaid(admin, 't1', d('2026-08-24'));
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until.toISOString().slice(0, 10)).toBe('2026-09-24');
    expect(prisma.adminAuditLog.create).toHaveBeenCalled();
  });

  it('adiantado avanca a partir do paid_until futuro', async () => {
    const { svc, prisma } = makeSvc({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: 30000, billing_cycle_months: 3, billing_paid_until: d('2026-09-10') }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    await svc.markTenantPaid(admin, 't1', d('2026-08-24'));
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until.toISOString().slice(0, 10)).toBe('2026-12-10');
  });

  it('grava sempre ancorado no meio-dia UTC', async () => {
    const { svc, prisma } = makeSvc({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: 30000, billing_cycle_months: 1, billing_paid_until: null }),
        update: jest.fn().mockResolvedValue({}),
      },
    });
    // "hoje" às 23h de UTC: o resultado ainda tem de cair ao meio-dia, senão em
    // São Paulo (UTC-3) a data lida seria a do dia anterior.
    await svc.markTenantPaid(admin, 't1', new Date('2026-08-24T23:30:00Z'));
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until.toISOString()).toBe('2026-09-24T12:00:00.000Z');
  });

  it('rejeita sem ciclo configurado', async () => {
    const { svc } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X', billing_value: null, billing_cycle_months: null, billing_paid_until: null }), update: jest.fn() },
    });
    await expect(svc.markTenantPaid(admin, 't1')).rejects.toThrow('Cobrança não configurada');
  });

  it('404 quando o tenant nao existe', async () => {
    const { svc } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue(null), update: jest.fn() },
    });
    await expect(svc.markTenantPaid(admin, 'nope')).rejects.toThrow('Tenant não encontrado');
  });
});

describe('setTenantBilling', () => {
  it('grava os tres campos e audita', async () => {
    const { svc, prisma } = makeSvc({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }),
        update: jest.fn().mockResolvedValue({ billing_value: 30000, billing_cycle_months: 3, billing_paid_until: d('2026-09-10') }),
      },
    });
    await svc.setTenantBilling(admin, 't1', {
      billing_value: 30000,
      billing_cycle_months: 3,
      billing_paid_until: '2026-09-10T12:00:00.000Z',
    });
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_value).toBe(30000);
    expect(arg.data.billing_cycle_months).toBe(3);
    expect(arg.data.billing_paid_until.toISOString()).toBe('2026-09-10T12:00:00.000Z');
    expect(prisma.adminAuditLog.create).toHaveBeenCalled();
  });

  it('re-ancora meia-noite UTC no meio-dia (senao o dia lido em SP volta um)', async () => {
    const { svc, prisma } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }), update: jest.fn().mockResolvedValue({}) },
    });
    await svc.setTenantBilling(admin, 't1', { billing_paid_until: '2026-09-10T00:00:00.000Z' });
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until.toISOString()).toBe('2026-09-10T12:00:00.000Z');
  });

  it('campo ausente nao entra no update (patch parcial)', async () => {
    const { svc, prisma } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }), update: jest.fn().mockResolvedValue({}) },
    });
    await svc.setTenantBilling(admin, 't1', { billing_value: 15000 });
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(Object.keys(arg.data)).toEqual(['billing_value']);
  });

  it('null limpa o campo', async () => {
    const { svc, prisma } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }), update: jest.fn().mockResolvedValue({}) },
    });
    await svc.setTenantBilling(admin, 't1', { billing_paid_until: null, billing_cycle_months: null });
    const arg = (prisma.tenant.update as jest.Mock).mock.calls[0][0];
    expect(arg.data.billing_paid_until).toBeNull();
    expect(arg.data.billing_cycle_months).toBeNull();
  });

  it('rejeita ciclo fora de 1/3/6/12', async () => {
    const { svc } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }), update: jest.fn() },
    });
    await expect(svc.setTenantBilling(admin, 't1', { billing_cycle_months: 2 })).rejects.toThrow();
  });

  it('rejeita valor negativo', async () => {
    const { svc } = makeSvc({
      tenant: { findUnique: jest.fn().mockResolvedValue({ id: 't1', nome: 'X' }), update: jest.fn() },
    });
    await expect(svc.setTenantBilling(admin, 't1', { billing_value: -1 })).rejects.toThrow();
  });
});

describe('billingSummary', () => {
  it('normaliza para mensal e agrupa por status', async () => {
    const { svc } = makeSvc({
      tenant: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { billing_value: 120000, billing_cycle_months: 12, billing_paid_until: d('2027-01-01'), suspended_at: null },   // em_dia, 10000/mes
          { billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2026-08-01'), suspended_at: null },     // vencido
          { billing_value: null, billing_cycle_months: null, billing_paid_until: null, suspended_at: d('2026-08-01') },   // suspenso, sem cobranca
        ]),
        update: jest.fn(),
      },
    });
    const s = await svc.billingSummary(admin, d('2026-08-24'));
    expect(s.receita_mensal_esperada).toBe(40000);
    expect(s.em_dia).toEqual({ qtde: 1, valor_mensal: 10000 });
    expect(s.vencidos).toEqual({ qtde: 1, valor_mensal: 30000 });
    expect(s.suspensos).toBe(1);
  });

  it('conta vence_em_breve separado', async () => {
    const { svc } = makeSvc({
      tenant: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { id: 'a', billing_value: 60000, billing_cycle_months: 6, billing_paid_until: d('2026-08-26'), suspended_at: null },
        ]),
        update: jest.fn(),
      },
    });
    const s = await svc.billingSummary(admin, d('2026-08-24'));
    expect(s.vence_em_breve).toEqual({ qtde: 1, valor_mensal: 10000 });
    expect(s.em_dia).toEqual({ qtde: 0, valor_mensal: 0 });
    expect(s.receita_mensal_esperada).toBe(10000);
  });

  it('admin sem escopo total nao ve o tenant protegido no resumo', async () => {
    const { svc } = makeSvc({
      user: {
        findUnique: jest.fn().mockResolvedValue({ platform_scopes: ['tenants'] }),
        findMany: jest.fn().mockResolvedValue([{ tenant_id: 'protegido' }]),
        count: jest.fn().mockResolvedValue(0),
        updateMany: jest.fn(),
      },
      tenant: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          { id: 'protegido', billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2027-01-01'), suspended_at: null },
          { id: 'comum', billing_value: 30000, billing_cycle_months: 1, billing_paid_until: d('2027-01-01'), suspended_at: null },
        ]),
        update: jest.fn(),
      },
    });
    const s = await svc.billingSummary(admin, d('2026-08-24'));
    expect(s.em_dia).toEqual({ qtde: 1, valor_mensal: 30000 });
  });
});

describe('listTenants com billing', () => {
  it('cada linha carrega os campos de cobranca e o status derivado', async () => {
    const { svc } = makeSvc({
      tenant: {
        findUnique: jest.fn(),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 't1',
            nome: 'X',
            pool_enabled: false,
            created_at: d('2026-01-01'),
            owner: null,
            _count: { users: 1, leads: 2, instances: 0 },
            billing_value: 30000,
            billing_cycle_months: 1,
            billing_paid_until: d('2026-08-01'),
            suspended_at: d('2026-08-02'),
          },
        ]),
        update: jest.fn(),
      },
    });
    const rows = await svc.listTenants(admin);
    expect(rows[0].billing_value).toBe(30000);
    expect(rows[0].billing_cycle_months).toBe(1);
    expect(rows[0].suspended).toBe(true);
    expect(rows[0].billing.status).toBe('vencido');
  });
});
