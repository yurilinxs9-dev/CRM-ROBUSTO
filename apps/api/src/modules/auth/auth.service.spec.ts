import { UnauthorizedException, BadRequestException, HttpException } from '@nestjs/common';
import { AuthService } from './auth.service';
import * as bcrypt from 'bcryptjs';

/* eslint-disable @typescript-eslint/no-explicit-any */

function makeMocks() {
  const prisma: any = {
    user: { findUnique: jest.fn(), update: jest.fn() },
    refreshToken: {
      create: jest.fn().mockResolvedValue({ id: 'rt-new' }),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn(),
    },
    passwordResetToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    adminAuditLog: { create: jest.fn() },
    $transaction: jest.fn(async (arg: unknown) => {
      if (Array.isArray(arg)) return Promise.all(arg);
      return (arg as (tx: unknown) => unknown)(prisma);
    }),
  };
  const jwt: any = {
    sign: jest.fn().mockReturnValue('signed-token'),
    verify: jest.fn(),
    decode: jest.fn().mockReturnValue({ exp: Math.floor(Date.now() / 1000) + 3600 }),
  };
  const config: any = {
    get: jest.fn((key: string, def?: string) => def ?? undefined),
  };
  const cache: any = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn(),
    del: jest.fn(),
    incr: jest.fn().mockResolvedValue(1),
  };
  return { prisma, jwt, config, cache };
}

const activeUser = {
  id: 'u1',
  email: 'a@b.com',
  role: 'OPERADOR',
  tenant_id: 't1',
  ativo: true,
  senha_hash: bcrypt.hashSync('senha123', 4),
};

function makeService() {
  const m = makeMocks();
  const service = new AuthService(m.prisma, m.jwt, m.config, m.cache);
  return { service, ...m };
}

describe('AuthService.login — lockout progressivo', () => {
  it('login válido zera contadores e persiste sessão de refresh', async () => {
    const { service, prisma, cache } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);

    const r = await service.login('a@b.com', 'senha123');
    expect(r.accessToken).toBe('signed-token');
    expect(prisma.refreshToken.create).toHaveBeenCalledTimes(1);
    expect(cache.del).toHaveBeenCalledWith('auth:failcount:a@b.com');
    expect(cache.del).toHaveBeenCalledWith('auth:lock:a@b.com');
  });

  it('senha errada incrementa contador de falha', async () => {
    const { service, prisma, cache } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);

    await expect(service.login('a@b.com', 'errada')).rejects.toThrow(UnauthorizedException);
    expect(cache.incr).toHaveBeenCalledWith('auth:failcount:a@b.com', expect.any(Number));
  });

  it('5ª falha arma o lock', async () => {
    const { service, prisma, cache } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    cache.incr.mockResolvedValue(5);

    await expect(service.login('a@b.com', 'errada')).rejects.toThrow(UnauthorizedException);
    expect(cache.set).toHaveBeenCalledWith(
      'auth:lock:a@b.com',
      expect.any(Number),
      60, // 2^0 * 60s no threshold
    );
  });

  it('conta travada responde 429 sem nem consultar senha', async () => {
    const { service, prisma, cache } = makeService();
    cache.get.mockResolvedValue(Date.now() + 60_000);

    await expect(service.login('a@b.com', 'senha123')).rejects.toThrow(HttpException);
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('lock progressivo respeita o teto de 30min', async () => {
    const { service, prisma, cache } = makeService();
    prisma.user.findUnique.mockResolvedValue(activeUser);
    cache.incr.mockResolvedValue(50);

    await expect(service.login('a@b.com', 'errada')).rejects.toThrow(UnauthorizedException);
    expect(cache.set).toHaveBeenCalledWith('auth:lock:a@b.com', expect.any(Number), 1800);
  });
});

describe('AuthService.refreshToken — rotação e reuse-detection', () => {
  const payload = { sub: 'u1', remember: false };

  it('rotação: revoga o token usado e aponta replaced_by pro novo', async () => {
    const { service, prisma, jwt } = makeService();
    jwt.verify.mockReturnValue(payload);
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-old',
      family_id: 'fam1',
      revoked_at: null,
      expires_at: new Date(Date.now() + 10_000),
      user_id: 'u1',
    });
    prisma.user.findUnique.mockResolvedValue(activeUser);

    const r = await service.refreshToken('old-token');
    expect(r.accessToken).toBe('signed-token');
    // novo token criado na MESMA família
    expect(prisma.refreshToken.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ family_id: 'fam1' }) }),
    );
    expect(prisma.refreshToken.update).toHaveBeenCalledWith({
      where: { id: 'rt-old' },
      data: expect.objectContaining({ revoked_at: expect.any(Date), replaced_by: 'rt-new' }),
    });
  });

  it('REUSO de token revogado revoga a família inteira e nega', async () => {
    const { service, prisma, jwt } = makeService();
    jwt.verify.mockReturnValue(payload);
    prisma.refreshToken.findUnique.mockResolvedValue({
      id: 'rt-old',
      family_id: 'fam1',
      revoked_at: new Date(),
      expires_at: new Date(Date.now() + 10_000),
      user_id: 'u1',
    });

    await expect(service.refreshToken('stolen')).rejects.toThrow('Sessao revogada');
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { family_id: 'fam1', revoked_at: null },
      data: { revoked_at: expect.any(Date) },
    });
    expect(prisma.refreshToken.create).not.toHaveBeenCalled();
  });

  it('token legado (sem row no banco) com assinatura válida é adotado em família nova', async () => {
    const { service, prisma, jwt } = makeService();
    jwt.verify.mockReturnValue(payload);
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue(activeUser);

    const r = await service.refreshToken('legacy');
    expect(r.accessToken).toBe('signed-token');
    expect(prisma.refreshToken.create).toHaveBeenCalled();
    expect(prisma.refreshToken.update).not.toHaveBeenCalled();
  });

  it('assinatura inválida nega sem tocar no banco', async () => {
    const { service, prisma, jwt } = makeService();
    jwt.verify.mockImplementation(() => {
      throw new Error('bad sig');
    });

    await expect(service.refreshToken('junk')).rejects.toThrow(UnauthorizedException);
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });

  it('usuário desativado nega mesmo com token válido', async () => {
    const { service, prisma, jwt } = makeService();
    jwt.verify.mockReturnValue(payload);
    prisma.refreshToken.findUnique.mockResolvedValue(null);
    prisma.user.findUnique.mockResolvedValue({ ...activeUser, ativo: false });

    await expect(service.refreshToken('t')).rejects.toThrow(UnauthorizedException);
  });
});

describe('AuthService.logout', () => {
  it('revoga a família da sessão', async () => {
    const { service, prisma } = makeService();
    prisma.refreshToken.findUnique.mockResolvedValue({ family_id: 'fam9' });

    await service.logout('some-token');
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { family_id: 'fam9', revoked_at: null },
      data: { revoked_at: expect.any(Date) },
    });
  });

  it('sem cookie é no-op', async () => {
    const { service, prisma } = makeService();
    await service.logout(undefined);
    expect(prisma.refreshToken.findUnique).not.toHaveBeenCalled();
  });
});

describe('AuthService.resetPassword', () => {
  it('token válido troca a senha e revoga todas as sessões', async () => {
    const { service, prisma } = makeService();
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'pr1',
      user_id: 'u1',
      used_at: null,
      expires_at: new Date(Date.now() + 60_000),
    });

    await service.resetPassword('raw-token-raw-token-raw-token-32', 'novaSenha123');
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: 'u1' },
      data: { senha_hash: expect.any(String) },
    });
    expect(prisma.passwordResetToken.update).toHaveBeenCalledWith({
      where: { id: 'pr1' },
      data: { used_at: expect.any(Date) },
    });
    expect(prisma.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { user_id: 'u1', revoked_at: null },
      data: { revoked_at: expect.any(Date) },
    });
  });

  it('token usado ou expirado nega', async () => {
    const { service, prisma } = makeService();
    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'pr1',
      user_id: 'u1',
      used_at: new Date(),
      expires_at: new Date(Date.now() + 60_000),
    });
    await expect(service.resetPassword('t'.repeat(32), 'x'.repeat(10))).rejects.toThrow(
      BadRequestException,
    );

    prisma.passwordResetToken.findUnique.mockResolvedValue({
      id: 'pr2',
      user_id: 'u1',
      used_at: null,
      expires_at: new Date(Date.now() - 1),
    });
    await expect(service.resetPassword('t'.repeat(32), 'x'.repeat(10))).rejects.toThrow(
      BadRequestException,
    );
  });

  it('token inexistente nega', async () => {
    const { service, prisma } = makeService();
    prisma.passwordResetToken.findUnique.mockResolvedValue(null);
    await expect(service.resetPassword('t'.repeat(32), 'x'.repeat(10))).rejects.toThrow(
      BadRequestException,
    );
  });
});

describe('AuthService.forgotPassword', () => {
  it('email existente cria token de reset com expiração ~1h', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue({ id: 'u1', ativo: true });

    const r = await service.forgotPassword('a@b.com');
    expect(r.message).toMatch(/Se o e-mail existir/);
    const call = prisma.passwordResetToken.create.mock.calls[0][0];
    expect(call.data.user_id).toBe('u1');
    const delta = call.data.expires_at.getTime() - Date.now();
    expect(delta).toBeGreaterThan(55 * 60 * 1000);
    expect(delta).toBeLessThanOrEqual(60 * 60 * 1000);
  });

  it('email inexistente responde IGUAL sem criar token (anti-enumeração)', async () => {
    const { service, prisma } = makeService();
    prisma.user.findUnique.mockResolvedValue(null);

    const r = await service.forgotPassword('ghost@b.com');
    expect(r.message).toMatch(/Se o e-mail existir/);
    expect(prisma.passwordResetToken.create).not.toHaveBeenCalled();
  });
});
