import { AuthGuard } from '@nestjs/passport';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { UnauthorizedException } from '@nestjs/common';

describe('JwtAuthGuard restricted policy ordering', () => {
  const passport = AuthGuard('jwt').prototype;
  afterEach(() => jest.restoreAllMocks());
  function setup(isPublic = false) {
    const req = { method: 'GET', url: '/partners', user: undefined };
    const context = { getHandler: () => null, getClass: () => null, switchToHttp: () => ({ getRequest: () => req }) };
    const reflector = { getAllAndOverride: () => isPublic };
    const policy = { assertAllowed: jest.fn(async () => { if (!req.user) throw new Error('not authenticated'); }) };
    const guard = new JwtAuthGuard(reflector as never, policy as never);
    return { req, context: context as never, policy, guard };
  }
  it('runs policy after passport populates database-backed user', async () => {
    const m = setup();
    jest.spyOn(passport, 'canActivate').mockImplementation(async () => { (m.req as any).user = { id: 'db-user' }; return true; });
    expect(await m.guard.canActivate(m.context)).toBe(true);
    expect(m.policy.assertAllowed).toHaveBeenCalledWith(m.req);
  });
  it('does not authorize when passport rejects', async () => {
    const m = setup();
    jest.spyOn(passport, 'canActivate').mockRejectedValue(new UnauthorizedException());
    await expect(m.guard.canActivate(m.context)).rejects.toBeInstanceOf(UnauthorizedException);
    expect(m.policy.assertAllowed).not.toHaveBeenCalled();
  });
  it('keeps public endpoints public', async () => {
    const m = setup(true);
    expect(await m.guard.canActivate(m.context)).toBe(true);
    expect(m.policy.assertAllowed).not.toHaveBeenCalled();
  });
  it('propagates policy denial', async () => {
    const m = setup();
    jest.spyOn(passport, 'canActivate').mockResolvedValue(true);
    m.policy.assertAllowed.mockRejectedValue(new Error('denied'));
    await expect(m.guard.canActivate(m.context)).rejects.toThrow('denied');
  });
});
