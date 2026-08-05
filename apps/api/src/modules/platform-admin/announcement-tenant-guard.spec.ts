import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';

// UUIDs de verdade: o announcementSchema valida target_tenant_id com
// z.string().uuid(), então um id fake rejeitaria por Zod e não pelo guard.
const MASTER_TENANT = '282a5498-9592-4efe-b441-1a6b40f8a4ce';
const OUTRO_TENANT = 'abf897e0-8e5c-491e-852e-4669306ec781';
// Tenant que hospeda um platform admin SEM escopo '*' — não deve ser protegido.
const TENANT_ADMIN_SEM_STAR = 'c15129aa-8ba9-45fc-8b3b-58cbc648df01';

const MASTER = { id: 'admin-master' } as never;
const RESTRITO = { id: 'admin-restrito' } as never;

type FakeUser = {
  tenant_id: string;
  ativo: boolean;
  is_platform_admin: boolean;
  platform_scopes: string[];
};

// Base fake dos usuários usada pelo mock de prisma.user.count, para que o
// where de isProtectedTenant seja avaliado de verdade (tenant_id E ativo E
// is_platform_admin E platform_scopes contendo '*') em vez de decidir só por
// tenant_id — do contrário, apagar os outros filtros na implementação não
// quebraria teste nenhum.
const FAKE_USERS: FakeUser[] = [
  // MASTER_TENANT hospeda o admin master, ativo, com escopo total.
  { tenant_id: MASTER_TENANT, ativo: true, is_platform_admin: true, platform_scopes: ['*'] },
  // OUTRO_TENANT só tem usuário comum — nada de platform admin.
  { tenant_id: OUTRO_TENANT, ativo: true, is_platform_admin: false, platform_scopes: [] },
  // TENANT_ADMIN_SEM_STAR hospeda um platform admin ativo, mas sem '*'.
  { tenant_id: TENANT_ADMIN_SEM_STAR, ativo: true, is_platform_admin: true, platform_scopes: ['announcements'] },
];

type UserCountWhere = {
  tenant_id: string;
  ativo?: boolean;
  is_platform_admin?: boolean;
  platform_scopes?: { has: string };
};

function countFakeUsers(where: UserCountWhere): number {
  return FAKE_USERS.filter((u) => {
    if (u.tenant_id !== where.tenant_id) return false;
    if (where.ativo !== undefined && u.ativo !== where.ativo) return false;
    if (where.is_platform_admin !== undefined && u.is_platform_admin !== where.is_platform_admin) return false;
    if (where.platform_scopes?.has !== undefined && !u.platform_scopes.includes(where.platform_scopes.has)) return false;
    return true;
  }).length;
}

function makeService() {
  const prisma = {
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ platform_scopes: where.id === 'admin-master' ? ['*'] : ['announcements'] }),
      ),
      count: jest.fn(({ where }: { where: UserCountWhere }) => Promise.resolve(countFakeUsers(where))),
    },
    announcement: {
      create: jest.fn().mockResolvedValue({ id: 'ann-1' }),
      update: jest.fn().mockResolvedValue({ id: 'ann-1' }),
      findUnique: jest.fn().mockResolvedValue({ target_tenant_id: MASTER_TENANT }),
    },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
  };
  const svc = new PlatformAdminService(prisma as never, {} as never, {} as never);
  return { svc, prisma };
}

const body = (target: string | null) => ({
  title: 'Aviso',
  body: 'Texto do aviso',
  level: 'INFO' as const,
  target_tenant_id: target,
});

describe('avisos — tenant do admin master é intocável', () => {
  it('admin restrito não cria aviso direcionado ao tenant master', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.createAnnouncement(RESTRITO, body(MASTER_TENANT))).rejects.toThrow(ForbiddenException);
    expect(prisma.announcement.create).not.toHaveBeenCalled();
  });

  it('admin restrito cria aviso para outro tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(RESTRITO, body(OUTRO_TENANT));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('admin restrito cria aviso global (sem tenant alvo)', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(RESTRITO, body(null));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('master cria aviso direcionado ao próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(MASTER, body(MASTER_TENANT));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('admin restrito não ativa/desativa aviso do tenant master', async () => {
    const { svc, prisma } = makeService();
    await expect(svc.setAnnouncementActive(RESTRITO, 'ann-1', false)).rejects.toThrow(ForbiddenException);
    expect(prisma.announcement.update).not.toHaveBeenCalled();
  });

  it('master ativa/desativa aviso do próprio tenant', async () => {
    const { svc, prisma } = makeService();
    await svc.setAnnouncementActive(MASTER, 'ann-1', false);
    expect(prisma.announcement.update).toHaveBeenCalled();
  });

  it('tenant com platform admin sem escopo total não é protegido — restrito cria aviso direcionado a ele', async () => {
    const { svc, prisma } = makeService();
    await svc.createAnnouncement(RESTRITO, body(TENANT_ADMIN_SEM_STAR));
    expect(prisma.announcement.create).toHaveBeenCalled();
  });

  it('ativar/desativar aviso inexistente devolve 404, não 500', async () => {
    const { svc, prisma } = makeService();
    prisma.announcement.findUnique.mockResolvedValueOnce(null);
    await expect(svc.setAnnouncementActive(MASTER, 'ann-inexistente', true)).rejects.toThrow(NotFoundException);
    expect(prisma.announcement.update).not.toHaveBeenCalled();
  });
});
