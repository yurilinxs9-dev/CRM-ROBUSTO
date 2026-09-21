import { canAccessFinance, FINANCE_TENANT, FINANCE_USER } from './finance';
jest.mock('./api', () => ({ api: { request: jest.fn() } }));
describe('finance visibility', () => {
    it('allows the exact Paloma identity', () => { expect(canAccessFinance(FINANCE_TENANT, FINANCE_USER)).toBe(true); });
    it('rejects other admins, other tenants and absent identities', () => { expect(canAccessFinance(FINANCE_TENANT, 'admin')).toBe(false); expect(canAccessFinance('other', FINANCE_USER)).toBe(false); expect(canAccessFinance(FINANCE_TENANT)).toBe(false); expect(canAccessFinance()).toBe(false); });
});
