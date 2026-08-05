import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';

type DbUser = { is_platform_admin: boolean; ativo: boolean; platform_scopes: string[] } | null;

function makeGuard(dbUser: DbUser, required?: string) {
  const prisma = { user: { findUnique: jest.fn().mockResolvedValue(dbUser) } };
  const reflector = { getAllAndOverride: jest.fn().mockReturnValue(required) };
  return new PlatformAdminGuard(prisma as never, reflector as never);
}

function ctx(userId?: string): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user: userId ? { id: userId } : undefined }) }),
    getHandler: () => function handler() {},
    getClass: () => class Controller {},
  } as unknown as ExecutionContext;
}

const MASTER = { is_platform_admin: true, ativo: true, platform_scopes: ['*'] };
const LIMITED = { is_platform_admin: true, ativo: true, platform_scopes: ['health', 'ai'] };

describe('PlatformAdminGuard — escopos', () => {
  it('master passa em rota escopada', async () => {
    await expect(makeGuard(MASTER, 'health').canActivate(ctx('u1'))).resolves.toBe(true);
  });

  it('master passa em rota sem decorator', async () => {
    await expect(makeGuard(MASTER, undefined).canActivate(ctx('u1'))).resolves.toBe(true);
  });

  it('restrito passa no escopo que tem', async () => {
    await expect(makeGuard(LIMITED, 'health').canActivate(ctx('u1'))).resolves.toBe(true);
  });

  it('restrito é barrado no escopo que não tem', async () => {
    // announcements não está na lista dele.
    await expect(makeGuard(LIMITED, 'announcements').canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('restrito é barrado em rota sem decorator', async () => {
    // Fail-closed: rota nova nasce só do master até alguém decidir abrir.
    await expect(makeGuard(LIMITED, undefined).canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('barra usuário inativo mesmo com escopo total', async () => {
    const inativo = { is_platform_admin: true, ativo: false, platform_scopes: ['*'] };
    await expect(makeGuard(inativo, 'health').canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('barra quem não é platform admin', async () => {
    const comum = { is_platform_admin: false, ativo: true, platform_scopes: ['*'] };
    await expect(makeGuard(comum, 'health').canActivate(ctx('u1'))).rejects.toThrow(ForbiddenException);
  });

  it('barra requisição sem usuário', async () => {
    await expect(makeGuard(MASTER, 'health').canActivate(ctx())).rejects.toThrow(ForbiddenException);
  });
});
