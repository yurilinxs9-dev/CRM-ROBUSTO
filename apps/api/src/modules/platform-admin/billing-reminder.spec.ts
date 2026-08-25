import { BillingReminderService } from './billing-reminder.service';

const d = (s: string) => new Date(`${s}T12:00:00Z`);

function makeSvc(tenants: unknown[], existing: unknown[] = []) {
  const prisma = {
    tenant: { findMany: jest.fn().mockResolvedValue(tenants) },
    announcement: {
      findFirst: jest.fn().mockImplementation(({ where }: { where: { title: string; target_tenant_id: string } }) =>
        Promise.resolve(
          (existing as Array<{ title: string; target_tenant_id: string }>).find(
            (a) => a.title === where.title && a.target_tenant_id === where.target_tenant_id,
          ) ?? null,
        ),
      ),
      create: jest.fn().mockResolvedValue({}),
    },
    user: { findFirst: jest.fn().mockResolvedValue({ id: 'master' }) },
  };
  return { svc: new BillingReminderService(prisma as never), prisma };
}

const tenant = (over: Record<string, unknown>) => ({
  id: 't1',
  billing_value: 30000,
  billing_cycle_months: 1,
  billing_paid_until: d('2026-08-26'),
  suspended_at: null,
  ...over,
});

describe('BillingReminderService.run', () => {
  it('cria aviso WARNING para vence_em_breve', async () => {
    const { svc, prisma } = makeSvc([tenant({})]);
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(1);
    const arg = (prisma.announcement.create as jest.Mock).mock.calls[0][0];
    expect(arg.data.title).toBe('Fatura vence em breve (26/08/2026)');
    expect(arg.data.target_tenant_id).toBe('t1');
    expect(arg.data.level).toBe('WARNING');
  });

  it('cria aviso para vencido e nao duplica se ja existe ativo com mesmo titulo', async () => {
    const { svc } = makeSvc(
      [tenant({ billing_paid_until: d('2026-08-20') })],
      [{ title: 'Fatura vencida (20/08/2026)', target_tenant_id: 't1' }],
    );
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(0);
  });

  it('ignora sem_cobranca, em_dia e suspensos', async () => {
    const { svc } = makeSvc([
      tenant({ billing_value: null, billing_paid_until: null }),
      tenant({ id: 't2', billing_paid_until: d('2026-12-01') }),
      tenant({ id: 't3', billing_paid_until: d('2026-08-20'), suspended_at: d('2026-08-01') }),
    ]);
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(0);
  });

  it('nao cria nada sem admin master ativo (created_by e NOT NULL)', async () => {
    const { svc, prisma } = makeSvc([tenant({ billing_paid_until: d('2026-08-20') })]);
    (prisma.user.findFirst as jest.Mock).mockResolvedValue(null);
    const r = await svc.run(d('2026-08-24'));
    expect(r.created).toBe(0);
    expect(prisma.announcement.create).not.toHaveBeenCalled();
  });
});
