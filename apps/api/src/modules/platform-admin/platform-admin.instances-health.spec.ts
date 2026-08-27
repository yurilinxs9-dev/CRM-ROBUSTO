import { PlatformAdminService } from './platform-admin.service';
import type { AuthUser } from '../../common/types/auth-user';

const master = { id: 'adm', email: 'a@a', tenantId: 't-adm', role: 'SUPER_ADMIN' } as unknown as AuthUser;
const restrito = { id: 'adm2', email: 'b@b', tenantId: 't-b', role: 'SUPER_ADMIN' } as unknown as AuthUser;

interface AlertaMock {
  aberto_em: Date;
}
interface LinhaMock {
  nome: string;
  status: string;
  ultimo_check: Date | null;
  config: unknown;
  tenant: { nome: string };
  alerts: AlertaMock[];
}

const linha = (over: Partial<LinhaMock> = {}): LinhaMock => ({
  nome: 'inst',
  status: 'open',
  ultimo_check: null,
  config: { uazapi_token: 'tok' },
  tenant: { nome: 'Tenant A' },
  alerts: [],
  ...over,
});

/**
 * `platform_scopes` do chamador decide se ele é o master ('*') ou o restrito —
 * é o que `hasFullScope` lê do banco. `user.findMany` alimenta
 * `protectedTenantIds` (tenants que hospedam um master).
 */
function makeSvc(linhas: LinhaMock[], opts: { full?: boolean; protegidos?: string[] } = {}) {
  const { full = true, protegidos = [] } = opts;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ platform_scopes: full ? ['*'] : ['health'] }),
      findMany: jest.fn().mockResolvedValue(protegidos.map((tenant_id) => ({ tenant_id }))),
    },
    whatsappInstance: {
      findMany: jest.fn().mockResolvedValue(linhas),
    },
  };
  const svc = new PlatformAdminService(prisma as never, {} as never, {} as never);
  return { svc, prisma };
}

describe('instancesHealth — shape', () => {
  it('devolve { instancias } com os campos do contrato', async () => {
    const { svc } = makeSvc([
      linha({
        nome: 'atendimento-alex',
        status: 'close',
        ultimo_check: new Date('2026-08-27T10:00:00Z'),
        tenant: { nome: 'Porto Sul' },
      }),
    ]);
    const out = await svc.instancesHealth(master);
    expect(out).toEqual({
      instancias: [
        {
          tenant: 'Porto Sul',
          nome: 'atendimento-alex',
          provider: 'uazapi',
          status: 'close',
          ultimo_check: '2026-08-27T10:00:00.000Z',
          caida_desde: null,
        },
      ],
    });
  });

  it('ultimo_check nulo continua nulo (nunca checada)', async () => {
    const { svc } = makeSvc([linha({ ultimo_check: null })]);
    const [i] = (await svc.instancesHealth(master)).instancias;
    expect(i.ultimo_check).toBeNull();
  });
});

describe('instancesHealth — provider derivado do config', () => {
  it('uazapi_token ⇒ uazapi', async () => {
    const { svc } = makeSvc([linha({ config: { uazapi_token: 'x' } })]);
    expect((await svc.instancesHealth(master)).instancias[0].provider).toBe('uazapi');
  });

  it('evolution_token ⇒ evolution', async () => {
    const { svc } = makeSvc([linha({ config: { provider: 'evolution', evolution_token: 'x' } })]);
    expect((await svc.instancesHealth(master)).instancias[0].provider).toBe('evolution');
  });

  it('sem token nenhum ⇒ legado (WPPConnect antigo)', async () => {
    const { svc } = makeSvc([linha({ config: { imported: true } })]);
    expect((await svc.instancesHealth(master)).instancias[0].provider).toBe('legado');
  });

  it('config nulo ⇒ legado, sem estourar', async () => {
    const { svc } = makeSvc([linha({ config: null })]);
    expect((await svc.instancesHealth(master)).instancias[0].provider).toBe('legado');
  });

  it('config que não é objeto (Json solto) ⇒ legado', async () => {
    const { svc } = makeSvc([linha({ config: 'texto-solto' })]);
    expect((await svc.instancesHealth(master)).instancias[0].provider).toBe('legado');
  });

  it('token vazio não conta como provider', async () => {
    const { svc } = makeSvc([linha({ config: { uazapi_token: '' } })]);
    expect((await svc.instancesHealth(master)).instancias[0].provider).toBe('legado');
  });
});

describe('instancesHealth — caida_desde', () => {
  it('usa o aberto_em do alerta em aberto', async () => {
    const { svc } = makeSvc([linha({ alerts: [{ aberto_em: new Date('2026-08-26T13:45:00Z') }] })]);
    expect((await svc.instancesHealth(master)).instancias[0].caida_desde).toBe('2026-08-26T13:45:00.000Z');
  });

  it('sem alerta aberto ⇒ null', async () => {
    const { svc } = makeSvc([linha({ alerts: [] })]);
    expect((await svc.instancesHealth(master)).instancias[0].caida_desde).toBeNull();
  });

  it('só lê alerta NÃO resolvido — o where vai ao banco', async () => {
    const { svc, prisma } = makeSvc([linha()]);
    await svc.instancesHealth(master);
    const arg = (prisma.whatsappInstance.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.select.alerts.where).toEqual({ resolvido_em: null });
  });
});

describe('instancesHealth — ordenação', () => {
  it('caídas primeiro (mais antiga no topo), depois tenant e nome', async () => {
    const { svc } = makeSvc([
      linha({ tenant: { nome: 'Alfa' }, nome: 'a1' }),
      linha({ tenant: { nome: 'Zulu' }, nome: 'z9', alerts: [{ aberto_em: new Date('2026-08-20T00:00:00Z') }] }),
      linha({ tenant: { nome: 'Alfa' }, nome: 'a2', alerts: [{ aberto_em: new Date('2026-08-25T00:00:00Z') }] }),
      linha({ tenant: { nome: 'Alfa' }, nome: 'a0' }),
      linha({ tenant: { nome: 'Beta' }, nome: 'b1' }),
    ]);
    const nomes = (await svc.instancesHealth(master)).instancias.map((i) => i.nome);
    expect(nomes).toEqual(['z9', 'a2', 'a0', 'a1', 'b1']);
  });

  it('empate de tenant desempata pelo nome da instância', async () => {
    const { svc } = makeSvc([
      linha({ tenant: { nome: 'Alfa' }, nome: 'zeta' }),
      linha({ tenant: { nome: 'Alfa' }, nome: 'alfa' }),
    ]);
    const nomes = (await svc.instancesHealth(master)).instancias.map((i) => i.nome);
    expect(nomes).toEqual(['alfa', 'zeta']);
  });
});

describe('instancesHealth — exclusões', () => {
  it('tenant suspenso fica de fora — filtrado no banco', async () => {
    const { svc, prisma } = makeSvc([linha()]);
    await svc.instancesHealth(master);
    const arg = (prisma.whatsappInstance.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.tenant).toEqual({ suspended_at: null });
  });

  it('admin restrito não enxerga as instâncias do tenant do master', async () => {
    const { svc, prisma } = makeSvc([linha()], { full: false, protegidos: ['t-master'] });
    await svc.instancesHealth(restrito);
    const arg = (prisma.whatsappInstance.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.tenant_id).toEqual({ notIn: ['t-master'] });
  });

  it('master não filtra tenant nenhum', async () => {
    const { svc, prisma } = makeSvc([linha()], { full: true, protegidos: ['t-master'] });
    await svc.instancesHealth(master);
    const arg = (prisma.whatsappInstance.findMany as jest.Mock).mock.calls[0][0];
    expect(arg.where.tenant_id).toBeUndefined();
  });
});
