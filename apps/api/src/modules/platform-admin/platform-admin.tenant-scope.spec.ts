import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';
import type { AuthUser } from '../../common/types/auth-user';

/**
 * O admin restrito (lucas) tem as MESMAS áreas do master — o que ele não tem é
 * alcance sobre o tenant do master: não lista, não abre, não age sobre ele nem
 * sobre os usuários dele. Estes testes cobrem esse alcance rota a rota.
 */

// UUIDs de verdade (ids do banco são uuid; um id fake quebraria por outro motivo).
const MASTER_TENANT = '282a5498-9592-4efe-b441-1a6b40f8a4ce';
const RESTRITO_TENANT = 'c15129aa-8ba9-45fc-8b3b-58cbc648df01';
// Cliente comum: nenhum platform admin mora aqui, então dá até para excluir.
const OUTRO_TENANT = 'abf897e0-8e5c-491e-852e-4669306ec781';

const MASTER_ID = 'admin-master';
const RESTRITO_ID = 'admin-restrito';
// Usuário comum que MORA no tenant do master — o alvo que o restrito não alcança.
const USER_DO_MASTER = 'user-no-tenant-master';
const USER_COMUM = 'user-no-tenant-comum';

const authUser = (id: string, tenantId: string): AuthUser => ({
  id,
  nome: id,
  email: `${id}@crm.dev`,
  role: 'SUPER_ADMIN',
  ativo: true,
  tenantId,
});

const MASTER = authUser(MASTER_ID, MASTER_TENANT);
const RESTRITO = authUser(RESTRITO_ID, RESTRITO_TENANT);

type FakeUser = {
  id: string;
  nome: string;
  email: string;
  role: 'SUPER_ADMIN';
  tenant_id: string;
  ativo: boolean;
  is_platform_admin: boolean;
  platform_scopes: string[];
  owned_tenants: { id: string }[];
};

const user = (over: Partial<FakeUser> & { id: string; tenant_id: string }): FakeUser => ({
  nome: over.id,
  email: `${over.id}@crm.dev`,
  role: 'SUPER_ADMIN',
  ativo: true,
  is_platform_admin: false,
  platform_scopes: [],
  owned_tenants: [],
  ...over,
});

const FAKE_USERS: FakeUser[] = [
  // Master: ativo, platform admin, escopo total → torna MASTER_TENANT protegido.
  user({ id: MASTER_ID, tenant_id: MASTER_TENANT, is_platform_admin: true, platform_scopes: ['*'] }),
  // Restrito: todos os escopos nomeados, nenhum '*'. O tenant DELE não é
  // protegido justamente porque falta o '*'.
  user({
    id: RESTRITO_ID,
    tenant_id: RESTRITO_TENANT,
    is_platform_admin: true,
    platform_scopes: ['overview', 'tenants', 'tenant_actions', 'health', 'logs', 'announcements', 'ai'],
  }),
  user({ id: USER_DO_MASTER, tenant_id: MASTER_TENANT }),
  user({ id: USER_COMUM, tenant_id: OUTRO_TENANT }),
];

type UserWhere = {
  id?: string;
  tenant_id?: string;
  ativo?: boolean;
  is_platform_admin?: boolean;
  platform_scopes?: { has: string };
};

/**
 * Filtra a base fake pelo `where` de verdade (ativo E is_platform_admin E
 * platform_scopes has '*'), para que apagar um desses filtros na implementação
 * quebre teste em vez de passar batido.
 */
function matchUsers(where: UserWhere): FakeUser[] {
  return FAKE_USERS.filter((u) => {
    if (where.id !== undefined && u.id !== where.id) return false;
    if (where.tenant_id !== undefined && u.tenant_id !== where.tenant_id) return false;
    if (where.ativo !== undefined && u.ativo !== where.ativo) return false;
    if (where.is_platform_admin !== undefined && u.is_platform_admin !== where.is_platform_admin) return false;
    if (where.platform_scopes?.has !== undefined && !u.platform_scopes.includes(where.platform_scopes.has)) return false;
    return true;
  });
}

const FAKE_TENANTS = [
  { id: MASTER_TENANT, nome: 'Tenant do master' },
  { id: RESTRITO_TENANT, nome: 'Tenant do admin restrito' },
  { id: OUTRO_TENANT, nome: 'Cliente comum' },
];

const tenantRow = (id: string, nome: string) => ({
  id,
  nome,
  pool_enabled: false,
  prefix_enabled: true,
  created_at: new Date('2026-01-01T00:00:00Z'),
  owner: { id: 'owner', nome: 'Owner', email: 'owner@crm.dev' },
  users: matchUsers({ tenant_id: id }).map((u) => ({ id: u.id, is_platform_admin: u.is_platform_admin })),
  instances: [],
  _count: { users: 1, leads: 0, instances: 0, messages: 0 },
});

const FAKE_ANNOUNCEMENTS = [
  { id: 'ann-global', target_tenant_id: null },
  { id: 'ann-do-master', target_tenant_id: MASTER_TENANT },
  { id: 'ann-comum', target_tenant_id: OUTRO_TENANT },
];

type AnnouncementWhere = {
  OR?: ({ target_tenant_id: null } | { target_tenant_id: { notIn: string[] } })[];
};

/**
 * Avalia o OR de verdade em vez de devolver a lista inteira — se a
 * implementação trocar o OR por um `notIn` seco, os avisos globais somem e o
 * teste pega.
 */
function matchAnnouncements(where: AnnouncementWhere) {
  const or = where.OR;
  if (!or) return FAKE_ANNOUNCEMENTS;
  return FAKE_ANNOUNCEMENTS.filter((a) =>
    or.some((cond) => {
      const target = cond.target_tenant_id;
      if (target === null) return a.target_tenant_id === null;
      return a.target_tenant_id !== null && !target.notIn.includes(a.target_tenant_id);
    }),
  );
}

// ---- Logs -------------------------------------------------------------------
// Cada lista tem uma linha que denuncia o master (autor master ou tenant
// protegido), uma linha de campo nulo (que NÃO pode sumir junto) e uma comum.
const FAKE_AUDIT = [
  { id: 'audit-do-master', admin_user_id: MASTER_ID, action: 'tenant_delete', target_tenant_id: OUTRO_TENANT },
  { id: 'audit-alvo-protegido', admin_user_id: RESTRITO_ID, action: 'user_ban', target_tenant_id: MASTER_TENANT },
  { id: 'audit-sem-alvo', admin_user_id: RESTRITO_ID, action: 'announcement_create', target_tenant_id: null },
  { id: 'audit-comum', admin_user_id: RESTRITO_ID, action: 'user_ban', target_tenant_id: OUTRO_TENANT },
  { id: 'login-do-master', admin_user_id: MASTER_ID, action: 'login_success', target_tenant_id: null },
  { id: 'login-alvo-protegido', admin_user_id: RESTRITO_ID, action: 'login_failed', target_tenant_id: MASTER_TENANT },
  { id: 'login-comum', admin_user_id: RESTRITO_ID, action: 'login_failed', target_tenant_id: null },
];

const FAKE_WEBHOOK_ERRORS = [
  { id: 'wh-do-master', tenant_id: MASTER_TENANT },
  { id: 'wh-sem-tenant', tenant_id: null },
  { id: 'wh-comum', tenant_id: OUTRO_TENANT },
];

const FAKE_API_ERRORS = [
  { id: 'api-do-master', tenant_id: MASTER_TENANT },
  { id: 'api-comum', tenant_id: OUTRO_TENANT },
];

type NullableTenantOr = ({ tenant_id: null } | { tenant_id: { notIn: string[] } })[];

type AuditWhere = {
  action: { in?: string[]; notIn?: string[] };
  admin_user_id?: { notIn: string[] };
  OR?: ({ target_tenant_id: null } | { target_tenant_id: { notIn: string[] } })[];
};

/**
 * Avalia o where de verdade — inclusive o OR. Se a implementação trocar o OR
 * por um `notIn` seco, as linhas de campo nulo somem e o teste pega.
 */
function matchAudit(where: AuditWhere) {
  return FAKE_AUDIT.filter((r) => {
    if (where.action.in && !where.action.in.includes(r.action)) return false;
    if (where.action.notIn && where.action.notIn.includes(r.action)) return false;
    if (where.admin_user_id && where.admin_user_id.notIn.includes(r.admin_user_id)) return false;
    if (where.OR) {
      const visible = where.OR.some((cond) =>
        cond.target_tenant_id === null
          ? r.target_tenant_id === null
          : r.target_tenant_id !== null && !cond.target_tenant_id.notIn.includes(r.target_tenant_id),
      );
      if (!visible) return false;
    }
    return true;
  });
}

function matchByTenant<T extends { tenant_id: string | null }>(rows: T[], or?: NullableTenantOr, notIn?: string[]) {
  return rows.filter((r) => {
    if (notIn && r.tenant_id !== null && notIn.includes(r.tenant_id)) return false;
    if (or) {
      return or.some((cond) =>
        cond.tenant_id === null
          ? r.tenant_id === null
          : r.tenant_id !== null && !cond.tenant_id.notIn.includes(r.tenant_id),
      );
    }
    return true;
  });
}

/** Modelos que só participam do cascade de deleteTenant/deleteUser. */
const CASCADE_MODELS = [
  'leadTag', 'leadActivity', 'task', 'notification', 'instanceLog', 'instanceHidden',
  'userInstance', 'stage', 'pipeline', 'tag', 'quickReply', 'pushSubscription',
  'outboundWebhook', 'apiKey', 'webhookLog', 'broadcast', 'assignmentLog',
  'apiRequestLog', 'aiUsageLog', 'sector',
] as const;

type ModelStub = { deleteMany: jest.Mock; updateMany: jest.Mock; count: jest.Mock };
const modelStub = (): ModelStub => ({
  deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
  updateMany: jest.fn().mockResolvedValue({ count: 0 }),
  count: jest.fn().mockResolvedValue(0),
});

function makeService() {
  const cascade: Record<string, ModelStub> = {};
  for (const m of CASCADE_MODELS) cascade[m] = modelStub();

  const prisma = {
    ...cascade,
    user: {
      ...modelStub(),
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(matchUsers({ id: where.id })[0] ?? null),
      ),
      // Honra o `select` porque protectedTenantIds pede tenant_id e
      // protectedAdminIds pede id — devolver o campo errado quebraria o filtro.
      findMany: jest.fn(({ where, select }: { where: UserWhere; select?: { id?: boolean; tenant_id?: boolean } }) =>
        Promise.resolve(
          matchUsers(where).map((u) => ({
            ...(select?.id ? { id: u.id } : {}),
            ...(select?.tenant_id ? { tenant_id: u.tenant_id } : {}),
          })),
        ),
      ),
      count: jest.fn(({ where }: { where: UserWhere }) => Promise.resolve(matchUsers(where).length)),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 3 }),
      delete: jest.fn().mockResolvedValue({}),
    },
    tenant: {
      findMany: jest.fn(() => Promise.resolve(FAKE_TENANTS.map((t) => tenantRow(t.id, t.nome)))),
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        const t = FAKE_TENANTS.find((x) => x.id === where.id);
        return Promise.resolve(t ? tenantRow(t.id, t.nome) : null);
      }),
      update: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    lead: { ...modelStub(), count: jest.fn().mockResolvedValue(0) },
    message: { ...modelStub(), count: jest.fn().mockResolvedValue(0) },
    whatsappInstance: { ...modelStub(), groupBy: jest.fn().mockResolvedValue([]) },
    announcement: {
      findMany: jest.fn(({ where }: { where: AnnouncementWhere }) => Promise.resolve(matchAnnouncements(where))),
    },
    adminAuditLog: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn(({ where }: { where: AuditWhere; take: number }) => Promise.resolve(matchAudit(where))),
    },
    webhookLog: {
      ...cascade.webhookLog,
      findMany: jest.fn(({ where }: { where: { OR?: NullableTenantOr }; take: number }) =>
        Promise.resolve(matchByTenant(FAKE_WEBHOOK_ERRORS, where.OR)),
      ),
    },
    apiRequestLog: {
      ...cascade.apiRequestLog,
      findMany: jest.fn(({ where }: { where: { OR?: NullableTenantOr; tenant_id?: { notIn: string[] } }; take: number }) =>
        Promise.resolve(matchByTenant(FAKE_API_ERRORS, where.OR, where.tenant_id?.notIn)),
      ),
    },
    $transaction: jest.fn().mockResolvedValue([]),
  };

  const jwt = { sign: jest.fn().mockReturnValue('token-fake') };
  const config = { get: jest.fn().mockReturnValue('segredo') };
  const svc = new PlatformAdminService(prisma as never, jwt as never, config as never);
  return { svc, prisma, jwt };
}

describe('listTenants — tenant do master some da lista do restrito', () => {
  it('restrito não vê o tenant protegido', async () => {
    const { svc } = makeService();
    const list = await svc.listTenants(RESTRITO);
    expect(list.map((t) => t.id)).toEqual([RESTRITO_TENANT, OUTRO_TENANT]);
  });

  it('master vê todos os tenants', async () => {
    const { svc } = makeService();
    const list = await svc.listTenants(MASTER);
    expect(list.map((t) => t.id)).toEqual([MASTER_TENANT, RESTRITO_TENANT, OUTRO_TENANT]);
  });

  it('esconde numa consulta só — nada de checar tenant a tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.listTenants(RESTRITO);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.count).not.toHaveBeenCalled();
  });
});

describe('listAnnouncements — o uuid do tenant protegido não vaza pelos avisos', () => {
  it('restrito não recebe o aviso direcionado ao tenant protegido', async () => {
    const { svc } = makeService();
    const list = await svc.listAnnouncements(RESTRITO);
    expect(list.map((a) => a.id)).toEqual(['ann-global', 'ann-comum']);
  });

  it('master recebe todos os avisos', async () => {
    const { svc } = makeService();
    const list = await svc.listAnnouncements(MASTER);
    expect(list.map((a) => a.id)).toEqual(['ann-global', 'ann-do-master', 'ann-comum']);
  });
});

describe('getTenant — abrir a ficha do tenant protegido', () => {
  it('restrito leva 403 e nem chega a ler o tenant', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.getTenant(RESTRITO, MASTER_TENANT)).rejects.toThrow(ForbiddenException);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('master abre normalmente', async () => {
    const { svc } = makeService();
    await expect(svc.getTenant(MASTER, MASTER_TENANT)).resolves.toMatchObject({ id: MASTER_TENANT });
  });

  it('restrito abre um tenant comum', async () => {
    const { svc } = makeService();
    await expect(svc.getTenant(RESTRITO, OUTRO_TENANT)).resolves.toMatchObject({ id: OUTRO_TENANT });
  });
});

describe('setUserBanned — usuário do tenant protegido', () => {
  it('restrito leva 403 e não muda nada', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setUserBanned(RESTRITO, USER_DO_MASTER, true)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('restrito não consegue banir o próprio master', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setUserBanned(RESTRITO, MASTER_ID, true)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('master bane usuário do próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setUserBanned(MASTER, USER_DO_MASTER, true)).resolves.toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalled();
  });

  it('restrito bane usuário de tenant comum', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setUserBanned(RESTRITO, USER_COMUM, true)).resolves.toEqual({ ok: true });
    expect(prisma.user.update).toHaveBeenCalled();
  });
});

describe('deleteUser — usuário do tenant protegido', () => {
  it('restrito leva 403 e não apaga', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.deleteUser(RESTRITO, USER_DO_MASTER)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.delete).not.toHaveBeenCalled();
  });

  it('master apaga usuário do próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.deleteUser(MASTER, USER_DO_MASTER)).resolves.toEqual({ ok: true });
    expect(prisma.user.delete).toHaveBeenCalled();
  });

  it('restrito apaga usuário de tenant comum', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.deleteUser(RESTRITO, USER_COMUM)).resolves.toEqual({ ok: true });
    expect(prisma.user.delete).toHaveBeenCalled();
  });

  it('os leads do usuário apagado vão pra NUVEM (returned_at carimbado)', async () => {
    // Task 5: desvincular sem carimbar deixaria os leads sem dono E fora da
    // nuvem — invisíveis pra qualquer operador em modo foco, ou seja, perdidos.
    const { svc, prisma } = makeService();
    await svc.deleteUser(RESTRITO, USER_COMUM);
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { responsavel_id: USER_COMUM },
      data: { responsavel_id: null, returned_at: expect.any(Date) },
    });
  });
});

describe('impersonate — usuário do tenant protegido', () => {
  it('restrito leva 403 e nenhum token é emitido', async () => {
    const { svc, jwt } = makeService();
    await expect(svc.impersonate(RESTRITO, USER_DO_MASTER)).rejects.toThrow(ForbiddenException);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('restrito não vira o próprio master', async () => {
    const { svc, jwt } = makeService();
    await expect(svc.impersonate(RESTRITO, MASTER_ID)).rejects.toThrow(ForbiddenException);
    expect(jwt.sign).not.toHaveBeenCalled();
  });

  it('master impersona usuário do próprio tenant', async () => {
    const { svc, jwt } = makeService();
    await expect(svc.impersonate(MASTER, USER_DO_MASTER)).resolves.toMatchObject({ accessToken: 'token-fake' });
    expect(jwt.sign).toHaveBeenCalled();
  });

  it('restrito impersona usuário de tenant comum', async () => {
    const { svc, jwt } = makeService();
    await expect(svc.impersonate(RESTRITO, USER_COMUM)).resolves.toMatchObject({ accessToken: 'token-fake' });
    expect(jwt.sign).toHaveBeenCalled();
  });
});

describe('deleteTenant — tenant protegido', () => {
  it('restrito leva 403 antes mesmo de ler o tenant', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.deleteTenant(RESTRITO, MASTER_TENANT)).rejects.toThrow(ForbiddenException);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('master passa pela checagem de escopo e só esbarra na regra antiga', async () => {
    // O tenant do master hospeda um platform admin, então a exclusão sempre
    // para no ConflictException pré-existente. O que este teste trava é que o
    // master NÃO leva 403: ele passou do assertTenantAllowed.
    const { svc } = makeService();
    await expect(svc.deleteTenant(MASTER, MASTER_TENANT)).rejects.toThrow(ConflictException);
  });

  it('restrito exclui tenant comum', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.deleteTenant(RESTRITO, OUTRO_TENANT)).resolves.toEqual({ ok: true });
    expect(prisma.$transaction).toHaveBeenCalled();
  });
});

describe('logs — o master não pode aparecer nos logs do restrito', () => {
  it('auditoria: some a linha feita pelo master e a linha com alvo protegido', async () => {
    const { svc } = makeService();
    const { admin_audit } = await svc.logs(RESTRITO);
    expect(admin_audit.map((r) => r.id)).toEqual(['audit-sem-alvo', 'audit-comum']);
  });

  it('auditoria: linha sem target_tenant_id continua aparecendo', async () => {
    const { svc } = makeService();
    const { admin_audit } = await svc.logs(RESTRITO);
    expect(admin_audit.map((r) => r.id)).toContain('audit-sem-alvo');
  });

  it('tentativas de login: some o login do master e o alvo protegido', async () => {
    const { svc } = makeService();
    const { login_attempts } = await svc.logs(RESTRITO);
    expect(login_attempts.map((r) => r.id)).toEqual(['login-comum']);
  });

  it('erros de webhook: some o tenant protegido, fica o de tenant nulo', async () => {
    const { svc } = makeService();
    const { webhook_errors } = await svc.logs(RESTRITO);
    expect(webhook_errors.map((r) => r.id)).toEqual(['wh-sem-tenant', 'wh-comum']);
  });

  it('erros de API: some o tenant protegido', async () => {
    const { svc } = makeService();
    const { api_errors } = await svc.logs(RESTRITO);
    expect(api_errors.map((r) => r.id)).toEqual(['api-comum']);
  });

  it('master recebe tudo', async () => {
    const { svc } = makeService();
    const logs = await svc.logs(MASTER);
    expect(logs.admin_audit.map((r) => r.id)).toEqual([
      'audit-do-master', 'audit-alvo-protegido', 'audit-sem-alvo', 'audit-comum',
    ]);
    expect(logs.login_attempts.map((r) => r.id)).toEqual([
      'login-do-master', 'login-alvo-protegido', 'login-comum',
    ]);
    expect(logs.webhook_errors.map((r) => r.id)).toEqual(['wh-do-master', 'wh-sem-tenant', 'wh-comum']);
    expect(logs.api_errors.map((r) => r.id)).toEqual(['api-do-master', 'api-comum']);
  });

  it('filtra no banco — os take continuam 50/50/30/30', async () => {
    const { svc, prisma } = makeService();
    await svc.logs(RESTRITO);
    expect(prisma.adminAuditLog.findMany.mock.calls.map((c) => c[0].take)).toEqual([50, 50]);
    expect(prisma.webhookLog.findMany.mock.calls[0][0].take).toBe(30);
    expect(prisma.apiRequestLog.findMany.mock.calls[0][0].take).toBe(30);
  });
});

describe('setTenantSuspended — tenant protegido', () => {
  it('restrito leva 403 e ninguém é suspenso', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setTenantSuspended(RESTRITO, MASTER_TENANT, true)).rejects.toThrow(ForbiddenException);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
  });

  it('master suspende o próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setTenantSuspended(MASTER, MASTER_TENANT, true)).resolves.toEqual({ ok: true, users_affected: 3 });
    expect(prisma.user.updateMany).toHaveBeenCalled();
  });

  it('restrito suspende tenant comum', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setTenantSuspended(RESTRITO, OUTRO_TENANT, true)).resolves.toEqual({ ok: true, users_affected: 3 });
    expect(prisma.user.updateMany).toHaveBeenCalled();
  });
});
