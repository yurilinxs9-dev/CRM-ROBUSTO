import { sessionAccessKey, userFromAuthMe } from './auth-user';

const user = { id: 'seller', nome: 'Seller', email: 'seller@example.test', role: 'OPERADOR', pl_sales_only: true };

describe('session profile from /auth/me', () => {
  it('hydrates the server opt-in with the current role and tenant', () => {
    expect(userFromAuthMe({ user, tenant: { id: 'pl' } })).toMatchObject({
      id: 'seller', role: 'OPERADOR', tenantId: 'pl', pl_sales_only: true, focus_mode: false,
    });
  });
  it('explicitly resets a removed or absent opt-in instead of keeping a persisted true flag', () => {
    expect(userFromAuthMe({ user: { ...user, pl_sales_only: false }, tenant: { id: 'pl' } }).pl_sales_only).toBe(false);
    expect(userFromAuthMe({ user: { ...user, pl_sales_only: undefined }, tenant: { id: 'pl' } }).pl_sales_only).toBe(false);
  });
  it('keeps the mounted session on ordinary refresh, but invalidates a different account or access profile', () => {
    const profile = userFromAuthMe({ user, tenant: { id: 'pl' } });
    const verified = sessionAccessKey(profile);
    expect(sessionAccessKey({ ...profile, nome: 'New display name' })).toBe(verified);
    expect(sessionAccessKey({ ...profile, id: 'other-user' })).not.toBe(verified);
    expect(sessionAccessKey({ ...profile, tenantId: 'other-tenant' })).not.toBe(verified);
    expect(sessionAccessKey({ ...profile, role: 'GERENTE' })).not.toBe(verified);
    expect(sessionAccessKey({ ...profile, pl_sales_only: false })).not.toBe(verified);
    expect(sessionAccessKey({ ...profile, focus_mode: true })).not.toBe(verified);
    expect(sessionAccessKey({ ...profile, pl_sales_only: undefined })).toBe(sessionAccessKey({ ...profile, pl_sales_only: false }));
  });
});
