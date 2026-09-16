import { canAccessPartners, PARTNERS_TENANT, parsePartnerAmount } from './partners';
describe('Partner sales boundaries', () => {
  it('is exclusive to the configured workspace', () => { expect(canAccessPartners(PARTNERS_TENANT)).toBe(true); expect(canAccessPartners('other')).toBe(false); expect(canAccessPartners()).toBe(false); });
  it('parses reais without losing cents', () => { expect(parsePartnerAmount('1.234,56')).toBe('1234.56'); expect(parsePartnerAmount('15000000')).toBe('15000000.00'); expect(parsePartnerAmount('0')).toBe('0.00'); });
  it.each(['', '-10', '1,001', '12.34', 'NaN', '1000000000000'])('rejects invalid money %s', input => { expect(() => parsePartnerAmount(input)).toThrow(); });
});
