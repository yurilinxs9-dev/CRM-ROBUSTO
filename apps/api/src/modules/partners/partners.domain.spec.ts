import { assertPartnerTenant, buildSummary } from './partners.domain';
import { dateSchema, moneySchema, monthSchema } from './partners.schemas';
describe('partners domain', () => {
  it('blocks other tenants', () => expect(() => assertPartnerTenant('other')).toThrow());
  it('validates cents and bounded positive amounts', () => {
    for (const value of ['0.001', '-1', '1000000000000', '', '1e3']) expect(moneySchema.safeParse(value).success).toBe(false);
    expect(moneySchema.safeParse('0').success).toBe(true);
  });
  it('validates real dates and months', () => {
    expect(dateSchema.safeParse('2026-02-30').success).toBe(false);
    expect(dateSchema.safeParse('2024-02-29').success).toBe(true);
    expect(monthSchema.safeParse('2026-13').success).toBe(false);
  });
  it('calculates target without rounding monetary totals', () => {
    const result = buildSummary('2026-09', '2026-09-16', '12000000', '15000000', '0', 2, 1);
    expect(result.remaining).toBe('3000000.00');
    expect(result.days_remaining).toBe(15);
    expect(result.required_per_day).toBe('200000.00');
    expect(buildSummary('2026-09','2026-09-16','1',null,'0',0,0).percentage).toBeNull();
    expect(buildSummary('2026-09','2026-09-16','2','1','0',0,0).remaining).toBe('0.00');
  });
});
describe('partner calendar',()=>{
 it('handles completed and future months and leap February',()=>{
  expect(buildSummary('2024-02','2024-02-01','0','29','0',0,0).days_remaining).toBe(29);
  expect(buildSummary('2026-08','2026-09-16','1','2','0',0,0).required_per_day).toBeNull();
  expect(buildSummary('2026-10','2026-09-16','0','31','0',0,0).required_per_day).toBe('1.00');
  expect(buildSummary('2026-09','2026-09-16','2','1','0',0,0).excess).toBe('1.00');
  expect(buildSummary('2026-09','2026-09-16','0','0','0',0,0).percentage).toBeNull();
 });
});
