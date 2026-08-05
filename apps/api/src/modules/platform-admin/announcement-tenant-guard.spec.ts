import { ForbiddenException } from '@nestjs/common';
import { PlatformAdminService } from './platform-admin.service';

// UUIDs de verdade: o announcementSchema valida target_tenant_id com
// z.string().uuid(), então um id fake rejeitaria por Zod e não pelo guard.
const MASTER_TENANT = '282a5498-9592-4efe-b441-1a6b40f8a4ce';
const OUTRO_TENANT = 'abf897e0-8e5c-491e-852e-4669306ec781';

const MASTER = { id: 'admin-master' } as never;
const RESTRITO = { id: 'admin-restrito' } as never;

function makeService() {
  const prisma = {
    user: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve({ platform_scopes: where.id === 'admin-master' ? ['*'] : ['announcements'] }),
      ),
      count: jest.fn(({ where }: { where: { tenant_id: string } }) =>
        Promise.resolve(where.tenant_id === MASTER_TENANT ? 1 : 0),
      ),
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
});
